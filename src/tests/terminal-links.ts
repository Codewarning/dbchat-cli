import assert from "node:assert/strict";
import {
  formatArtifactLineForTerminal,
  formatArtifactTextForTerminal,
  supportsOsc8Hyperlinks,
} from "../ui/terminal-links.js";
import type { RunTest } from "./support.js";

const OSC8_OPEN_HTML = "\u001b]8;;file:///tmp/dbchat/result.html\u0007";
const OSC8_OPEN_CSV = "\u001b]8;;file:///C:/tmp/dbchat%20result.csv\u0007";
const OSC8_CLOSE = "\u001b]8;;\u0007";
const HTML_VIEW_LABEL = "\u0048\u0054\u004d\u004c \u89c6\u56fe";

export async function registerTerminalLinkTests(runTest: RunTest): Promise<void> {
  await runTest("artifact browser links can render with ANSI styling and OSC 8 hyperlinks", () => {
    const formatted = formatArtifactLineForTerminal("Open full table in a browser: file:///tmp/dbchat/result.html", {
      ansi: true,
      hyperlinks: true,
    });

    assert.ok(formatted);
    assert.match(formatted, /\u001b\[1m\u001b\[38;5;81mOpen full table in a browser:/);
    assert.match(formatted, /\u001b\[38;5;81m\u001b\[4m/);
    assert.match(formatted, new RegExp(OSC8_OPEN_HTML.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
    assert.match(formatted, new RegExp(OSC8_CLOSE.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  });

  await runTest("artifact file paths can become clickable file URLs without changing displayed text", () => {
    const formatted = formatArtifactLineForTerminal("CSV file: C:\\tmp\\dbchat result.csv", {
      ansi: false,
      hyperlinks: true,
    });

    assert.ok(formatted);
    assert.match(formatted, /CSV file: /);
    assert.match(formatted, /C:\\tmp\\dbchat result\.csv/);
    assert.match(formatted, new RegExp(OSC8_OPEN_CSV.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
    assert.match(formatted, new RegExp(OSC8_CLOSE.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  });

  await runTest("generic user-authored artifact label lines can also become clickable", () => {
    const formatted = formatArtifactLineForTerminal(`${HTML_VIEW_LABEL}\uff1afile:///tmp/dbchat/result.html`, {
      ansi: true,
      hyperlinks: true,
    });

    assert.ok(formatted);
    assert.match(formatted, new RegExp(`${HTML_VIEW_LABEL}\uff1a`));
    assert.match(formatted, /\u001b\[38;5;81m\u001b\[4m/);
    assert.doesNotMatch(formatted, /\u001b\[38;5;81mHTML/);
    assert.match(formatted, new RegExp(OSC8_OPEN_HTML.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  });

  await runTest("non-artifact lines stay untouched by the artifact formatter", () => {
    assert.equal(formatArtifactLineForTerminal("SQL result rows 1-5 of 20:", { ansi: true, hyperlinks: true }), null);
    assert.equal(
      formatArtifactTextForTerminal("line one\nline two", { ansi: true, hyperlinks: true }),
      "line one\nline two",
    );
  });

  await runTest("OSC 8 hyperlink detection recognizes common supported terminals and respects overrides", () => {
    assert.equal(
      supportsOsc8Hyperlinks(
        { isTTY: true },
        {
          WT_SESSION: "1",
        } as NodeJS.ProcessEnv,
        {} as NodeJS.ProcessEnv,
      ),
      true,
    );
    assert.equal(
      supportsOsc8Hyperlinks(
        { isTTY: true },
        {
          TERM: "dumb",
          WT_SESSION: "1",
        } as NodeJS.ProcessEnv,
        {} as NodeJS.ProcessEnv,
      ),
      false,
    );
    assert.equal(
      supportsOsc8Hyperlinks(
        { isTTY: true },
        {
          FORCE_HYPERLINK: "0",
          WT_SESSION: "1",
        } as NodeJS.ProcessEnv,
        {} as NodeJS.ProcessEnv,
      ),
      false,
    );
    assert.equal(
      supportsOsc8Hyperlinks(
        { isTTY: true },
        {
          FORCE_HYPERLINK: "1",
          TERM: "dumb",
        } as NodeJS.ProcessEnv,
        {} as NodeJS.ProcessEnv,
      ),
      true,
    );
    assert.equal(
      supportsOsc8Hyperlinks(
        { isTTY: true },
        {} as NodeJS.ProcessEnv,
        {
          DBCHAT_FORCE_HYPERLINK: "0",
          WT_SESSION: "1",
        } as NodeJS.ProcessEnv,
      ),
      false,
    );
    assert.equal(
      supportsOsc8Hyperlinks(
        { isTTY: true },
        {
          TERM: "dumb",
        } as NodeJS.ProcessEnv,
        {
          DBCHAT_FORCE_HYPERLINK: "1",
        } as NodeJS.ProcessEnv,
      ),
      true,
    );
  });
}
