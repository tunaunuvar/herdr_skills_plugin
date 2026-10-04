"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { readsFromRecord, sessionUsage, findSession, filtered, norm, diskSkills, clean, findExecutable, toolsFromRecord, renderPanel, cellWidth, installedTools } = require("./skills");

test("skill usage comes from tool reads, not catalogues or conversation text", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-skills-test-"));
  try {
    const file = path.join(dir, "SKILL.md");
    const skills = [{ name: "sample", path: file, enabled: true }, { name: "off", path: "C:\\skills\\off\\SKILL.md", enabled: false }];
    const call = { timestamp: "2026-10-05", payload: { type: "function_call", arguments: JSON.stringify({ cmd: `Get-Content -LiteralPath '${file}'` }) } };
    assert.deepEqual(readsFromRecord(call, skills), [file]);
    assert.deepEqual(readsFromRecord({ payload: { type: "message", role: "developer", content: `cat ${file}` } }, skills), []);
    assert.deepEqual(readsFromRecord({ payload: { type: "function_call", arguments: JSON.stringify({ cmd: `rg --files '${file}'` }) } }, skills), []);
    const session = path.join(dir, "session.jsonl");
    fs.writeFileSync(session, JSON.stringify(call) + "\npartial");
    const usage = await sessionUsage(session, skills);
    assert.equal(usage.used.get(norm(file)), "2026-10-05");
    assert.match((await sessionUsage(null, skills)).note, /unknown/);
    assert.equal(filtered(skills, 4, "")[0].name, "off");
    assert.equal(filtered([{ ...skills[0], read: true }, skills[1]], 1, "sample").length, 1);
    assert.equal(findSession({ agent: "codex", agent_session: { kind: "id", value: "abc-123" } }, { codex: ["/rollout-abc-123.jsonl"] }), "/rollout-abc-123.jsonl");
    assert.equal(findSession({ agent: "codex", agent_session: { kind: "id", value: "missing" } }, { codex: ["/rollout-abc-123.jsonl"] }), null);
    assert.equal(norm("C:\\Skills\\demo\\SKILL.md", "win32"), norm("c:/skills/demo/SKILL.md", "win32"));
    assert.notEqual(norm("/skills/Demo/SKILL.md", "linux"), norm("/skills/demo/SKILL.md", "linux"));
    assert.notEqual(norm("/skills/Demo/SKILL.md", "darwin"), norm("/skills/demo/SKILL.md", "darwin"));
    assert.equal(clean("\x1b[2Jbad"), " [2Jbad");
    fs.mkdirSync(path.join(dir, ".agents", "skills", "sample"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".agents", "skills", "sample", "SKILL.md"), "---\nname: test-skill\ndescription: Sample\n---\n");
    assert.ok(diskSkills("codex", dir).some(s => s.name === "test-skill" && s.enabled === null));
    fs.writeFileSync(path.join(dir, "graft.cmd"), "test shim");
    assert.equal(norm(findExecutable("graft", { PATH: dir, PATHEXT: ".cmd" }, "win32")), norm(path.join(dir, "graft.cmd")));
    assert.equal(findExecutable("missing", { PATH: dir, PATHEXT: ".CMD" }, "win32"), null);
    const executable = path.join(dir, "example-tool");
    fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(executable, 0o755);
    const unixPath = path.relative(process.cwd(), dir);
    for (const platform of ["linux", "darwin"]) assert.equal(path.resolve(findExecutable("example-tool", { PATH: unixPath }, platform)), executable);
    if (process.platform !== "win32") { fs.chmodSync(executable, 0o644); assert.equal(findExecutable("example-tool", { PATH: dir }, "linux"), null); }
    const tools = [{ command: "graft", name: "Graft", path: path.join(dir, "graft.cmd"), enabled: true, type: "tool", description: "Code mapping" }];
    assert.deepEqual(toolsFromRecord({ payload: { type: "function_call", arguments: JSON.stringify({ cmd: "graft.cmd grep pets" }) } }, tools), [tools[0].path]);
    assert.deepEqual(toolsFromRecord({ payload: { type: "message", content: "graft.cmd grep pets" } }, tools), []);
    const data = { groups: [{ agent: "codex", skills, tools }], warnings: [], updatedAt: "12:00" };
    for (const [cols, rows] of [[110, 36], [60, 24], [32, 18], [20, 10]]) {
      const panel = renderPanel(data, { selected: 0, tab: 1, filter: 0, query: "", offset: 0 }, cols, rows);
      assert.equal(panel.lines.length, rows);
      assert.ok(panel.lines.every(s => [...s].reduce((n, c) => n + cellWidth(c), 0) <= cols - 2), `Panel exceeds ${cols} columns`);
      assert.ok(panel.lines.some(s => s.includes("Graft")));
      assert.ok(!panel.lines.some(s => /[çğıöşüÇĞİÖŞÜ]/.test(s)), "Built-in UI labels should be English");
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

if (process.argv.includes("--live")) {
  test("live Herdr/Codex discovery", async () => {
    const data = await require("./skills").snapshot();
    assert.ok(data.groups.some(g => g.agent === "codex" && g.skills.length));
    assert.equal(data.warnings.length, 0, data.warnings.join("; "));
    const expected = installedTools();
    assert.ok(data.groups.every(g => expected.every(t => g.tools.some(actual => actual.path === t.path && actual.enabled))), "Detected tools should be visible in every tools tab");
    assert.ok(data.groups.filter(g => g.agent !== "codex").every(g => g.skills.every(s => s.enabled === null)), "Other agents must not inherit Codex enablement");
    console.log(JSON.stringify(data.groups.map(g => ({ agent: g.agent, pane: g.pane_id, skills: g.skills.length, read: g.skills.filter(s => s.read).length, enabled: g.skills.filter(s => s.enabled === true).length })), null, 2));
    console.log(renderPanel(data, { selected: Math.max(0, data.groups.findIndex(g => g.focused)), tab: 1, filter: 0, query: "", offset: 0 }, 110, 36).lines.join("\n"));
  });
}
