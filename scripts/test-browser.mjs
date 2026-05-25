import { spawn } from "node:child_process";

function runCommand(command, args) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: false,
    });

    child.once("error", rejectCommand);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveCommand();
        return;
      }

      rejectCommand(
        new Error(
          signal
            ? `${command} ${args.join(" ")} exited with signal ${signal}.`
            : `${command} ${args.join(" ")} exited with code ${code ?? "unknown"}.`,
        ),
      );
    });
  });
}

await runCommand("pnpm", ["build"]);
await runCommand("node", ["tests/browser/youtube-subtitle.spec.mjs"]);
