import fs from 'fs';
import os from 'os';
import path from 'path';
import { CliId } from './store';

export interface ScannedSessionMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface ScannedLocalSession {
  key: string;
  cliId: CliId;
  externalSessionId: string;
  cwd: string;
  projectGuessName: string;
  title: string;
  messageCount: number;
  updatedAt: string;
  filePath: string;
}

function normalizeWinPath(p: string): string {
  return (p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function walkFiles(dir: string, filterExt: string, maxDepth = 4, out: string[] = [], depth = 0): string[] {
  if (depth > maxDepth || !fs.existsSync(dir)) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walkFiles(full, filterExt, maxDepth, out, depth + 1);
    } else if (ent.isFile() && ent.name.toLowerCase().endsWith(filterExt)) {
      out.push(full);
    }
  }
  return out;
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === 'string') {
        parts.push(item);
      } else if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        if (typeof obj.text === 'string') parts.push(obj.text);
        else if (typeof obj.content === 'string') parts.push(obj.content);
      }
    }
    return parts.join('\n').trim();
  }
  return '';
}

function cleanUserTitle(raw: string): string {
  const cleaned = raw
    .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 64) || '本地历史对话';
}

function parseCodexFile(filePath: string, includeMessages: boolean): {
  meta: ScannedLocalSession | null;
  messages: ScannedSessionMessage[];
} {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    let sessionId = '';
    let cwd = '';
    let firstUserText = '';
    let updatedAt = fs.statSync(filePath).mtime.toISOString();
    let msgCount = 0;
    const messages: ScannedSessionMessage[] = [];

    for (const line of lines) {
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof obj.timestamp === 'string') updatedAt = obj.timestamp;
      if (obj.type === 'session_meta' && obj.payload && typeof obj.payload === 'object') {
        const p = obj.payload as Record<string, unknown>;
        if (typeof p.session_id === 'string') sessionId = p.session_id;
        else if (typeof p.id === 'string') sessionId = p.id;
        if (typeof p.cwd === 'string') cwd = p.cwd;
      } else if (obj.type === 'response_item' && obj.payload && typeof obj.payload === 'object') {
        const p = obj.payload as Record<string, unknown>;
        const role = p.role === 'user' ? 'user' : p.role === 'assistant' ? 'assistant' : null;
        if (!role) continue;
        const text = extractTextFromContent(p.content);
        if (!text) continue;
        // Skip system/developer/AGENTS injected preamble blocks
        if (
          role === 'user' &&
          (text.startsWith('<environment_context>') ||
            text.startsWith('# AGENTS.md') ||
            text.startsWith('<INSTRUCTIONS>'))
        ) {
          continue;
        }
        msgCount += 1;
        if (role === 'user' && !firstUserText) {
          firstUserText = text;
        }
        if (includeMessages) {
          messages.push({
            role,
            content: text.slice(0, 8000),
            timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : updatedAt
          });
        }
      }
    }

    if (!sessionId || msgCount === 0) return { meta: null, messages: [] };
    const guessName = cwd ? path.basename(cwd) || cwd : 'Codex 本地项目';
    return {
      meta: {
        key: `codex::${sessionId}`,
        cliId: 'codex',
        externalSessionId: sessionId,
        cwd,
        projectGuessName: guessName,
        title: cleanUserTitle(firstUserText),
        messageCount: msgCount,
        updatedAt,
        filePath
      },
      messages
    };
  } catch {
    return { meta: null, messages: [] };
  }
}

function parseClaudeFile(filePath: string, includeMessages: boolean): {
  meta: ScannedLocalSession | null;
  messages: ScannedSessionMessage[];
} {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    let sessionId = path.basename(filePath, '.jsonl');
    let cwd = '';
    let firstUserText = '';
    let updatedAt = fs.statSync(filePath).mtime.toISOString();
    let msgCount = 0;
    const messages: ScannedSessionMessage[] = [];

    for (const line of lines) {
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof obj.sessionId === 'string') sessionId = obj.sessionId;
      if (typeof obj.timestamp === 'string') updatedAt = obj.timestamp;
      if (typeof obj.cwd === 'string' && !cwd) cwd = obj.cwd;
      if (obj.attachment && typeof obj.attachment === 'object') {
        const snap = (obj.attachment as Record<string, unknown>).snapshot as
          | Record<string, unknown>
          | undefined;
        if (snap && typeof snap.workingDirectory === 'string' && !cwd) {
          cwd = snap.workingDirectory;
        }
      }

      if (obj.type === 'user' || obj.type === 'assistant') {
        const msg = obj.message as Record<string, unknown> | undefined;
        const text = extractTextFromContent(msg?.content ?? obj.content);
        if (!text) continue;
        msgCount += 1;
        if (obj.type === 'user' && !firstUserText) {
          firstUserText = text;
        }
        if (includeMessages) {
          messages.push({
            role: obj.type === 'user' ? 'user' : 'assistant',
            content: text.slice(0, 8000),
            timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : updatedAt
          });
        }
      }
    }

    if (msgCount === 0) return { meta: null, messages: [] };
    if (!cwd) {
      // Decode Claude folder name e.g. D--FMC -> D:\FMC
      const parentName = path.basename(path.dirname(filePath));
      const m = parentName.match(/^([A-Za-z])--(.+)$/);
      if (m) cwd = `${m[1].toUpperCase()}:\\${m[2].replace(/-/g, '\\')}`;
    }
    const guessName = cwd ? path.basename(cwd) || cwd : 'Claude 本地项目';
    return {
      meta: {
        key: `claude::${sessionId}`,
        cliId: 'claude',
        externalSessionId: sessionId,
        cwd,
        projectGuessName: guessName,
        title: cleanUserTitle(firstUserText),
        messageCount: msgCount,
        updatedAt,
        filePath
      },
      messages
    };
  } catch {
    return { meta: null, messages: [] };
  }
}

export function scanLocalCliSessions(filterRepoPath?: string): ScannedLocalSession[] {
  const home = os.homedir();
  const normFilter = filterRepoPath ? normalizeWinPath(filterRepoPath) : '';
  const all: ScannedLocalSession[] = [];

  // 1. Codex sessions (~/.codex/sessions/**/*.jsonl)
  const codexDir = path.join(home, '.codex', 'sessions');
  const codexFiles = walkFiles(codexDir, '.jsonl', 4)
    .map((f) => ({ f, mtime: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 80);

  for (const { f } of codexFiles) {
    const { meta } = parseCodexFile(f, false);
    if (!meta) continue;
    if (normFilter && normalizeWinPath(meta.cwd) !== normFilter) continue;
    all.push(meta);
  }

  // 2. Claude sessions (~/.claude/projects/**/*.jsonl)
  const claudeDir = path.join(home, '.claude', 'projects');
  const claudeFiles = walkFiles(claudeDir, '.jsonl', 3)
    .map((f) => ({ f, mtime: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 80);

  for (const { f } of claudeFiles) {
    const { meta } = parseClaudeFile(f, false);
    if (!meta) continue;
    if (normFilter && normalizeWinPath(meta.cwd) !== normFilter) continue;
    all.push(meta);
  }

  return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 60);
}

export function readLocalCliSessionMessages(
  cliId: CliId,
  filePath: string
): { meta: ScannedLocalSession | null; messages: ScannedSessionMessage[] } {
  if (!filePath || !fs.existsSync(filePath)) return { meta: null, messages: [] };
  if (cliId === 'codex') return parseCodexFile(filePath, true);
  if (cliId === 'claude') return parseClaudeFile(filePath, true);
  return { meta: null, messages: [] };
}
