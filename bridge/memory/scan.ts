// Safety checks for anything that will be written into memory (and so, later, into the cat's
// system prompt). Idea and categories from Hermes Agent's tools/threat_patterns.py (MIT, Nous Research).

const THREATS: [RegExp, string][] = [
  // prompt injection: text that tries to give the model new orders
  [/\b(ignore|disregard|forget|override)\b.{0,30}\b(previous|prior|above|earlier|all|your)\b.{0,20}\b(instructions?|rules|prompts?|messages)\b/i, "prompt injection"],
  [/\byou are now\b|\bnew (system )?instructions?\s*:/i, "prompt injection"],
  [/\bsystem prompt\b/i, "prompt injection"],
  [/<\/?\s*(system|memory-context|instructions?)\s*>/i, "prompt injection"],
  [/^\s*\[system\]/im, "pretends to be a harness message"],
  // sending data somewhere
  [/\b(curl|wget|nc|netcat)\b[^\n]{0,80}https?:\/\//i, "sends data to a URL"],
  [/\b(send|post|upload|forward|exfiltrate)\b.{0,40}\bhttps?:\/\//i, "sends data to a URL"],
  // secrets
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/\b(sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|AIza[0-9A-Za-z_-]{30,}|xox[abpr]-[A-Za-z0-9-]{10,})/, "API key or token"],
  [/\b(password|passwd|api[_ -]?key|secret|token)\b\s*[:=]\s*\S{6,}/i, "password or secret"],
  // dangerous commands written as "facts"
  [/\brm\s+-[a-z]*r[a-z]*f?\s+[~\/]/i, "destructive command"],
  [/~\/\.ssh|authorized_keys|\.bashrc|\.zshrc|\.claude\/settings/i, "touches sensitive config files"],
  // invisible characters can hide instructions from a human reading the file
  [/[​-‏‪-‮⁠-⁤﻿]/, "invisible characters"],
];

/** Returns why the text is unsafe to remember, or undefined if it looks fine. */
export function threat(text: string): string | undefined {
  for (const [re, why] of THREATS) if (re.test(text)) return why;
  return undefined;
}

const SECRET = /(-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)|\b(sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|AIza[0-9A-Za-z_-]{30,}|xox[abpr]-[A-Za-z0-9-]{10,})|(\b(?:password|passwd|api[_ -]?key|secret|token)\b\s*[:=]\s*)\S+/gi;

/** Blank out secrets before a conversation line is stored in the session log. */
export function redact(text: string): string {
  return text.replace(SECRET, (_m, _pk, _tok, label) => (label ? `${label}[REDACTED]` : "[REDACTED]"));
}
