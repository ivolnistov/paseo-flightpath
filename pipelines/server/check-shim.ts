import type { ResolvedCommand } from "./commands";

/** Exit code of a shim that never received its release. */
export const SHIM_NOT_RELEASED = 125;
export const RELEASE_TOKEN = "go\n";

/**
 * The fixed launcher program. It reads file descriptor 3, a pipe whose write end only the server
 * holds, and runs its argument list only after reading exactly the release token. End of file,
 * an error or any other byte makes it exit without running anything. It ignores the polite stop
 * signals so that it outlives its command; a group kill ends both.
 */
export const SHIM_SOURCE = String.raw`
"use strict";
const { spawn } = require("node:child_process");
const fs = require("node:fs");
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => {});
const [mode, ...rest] = process.argv.slice(1);
const token = ${JSON.stringify(RELEASE_TOKEN)};
let received = "";
let started = false;
const refuse = () => { if (!started) process.exit(${SHIM_NOT_RELEASED}); };
const gate = fs.createReadStream("", { fd: 3, autoClose: true });
gate.on("error", refuse);
gate.on("end", refuse);
gate.on("close", refuse);
gate.on("data", (chunk) => {
  if (started) return;
  received += chunk.toString("utf8");
  if (received.length < token.length && token.startsWith(received)) return;
  if (received !== token) refuse();
  started = true;
  gate.destroy();
  run();
});
function run() {
  let file;
  let args;
  if (mode === "shell" && rest.length === 1) { file = "/bin/sh"; args = ["-c", rest[0]]; }
  else if (mode === "argv" && rest.length >= 1) { file = rest[0]; args = rest.slice(1); }
  else { process.stderr.write("pipeline shim: invalid command\n"); process.exit(126); }
  const child = spawn(file, args, { stdio: ["ignore", "inherit", "inherit"], shell: false });
  child.on("error", (error) => { process.stderr.write("pipeline shim: " + error.message + "\n"); process.exit(127); });
  child.on("exit", (code, signal) => {
    if (code !== null) process.exit(code);
    const number = signal ? (require("node:os").constants.signals[signal] || 0) : 0;
    process.exit(128 + number);
  });
}
`;

/** The shim's argument list for a command: the command is data, never program text. */
export function shimArgs(command: ResolvedCommand): string[] {
  return "shell" in command ? ["shell", command.shell] : ["argv", ...command.argv];
}
