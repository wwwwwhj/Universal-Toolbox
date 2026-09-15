import assert from "node:assert/strict";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const server = await createServer({ server: { middlewareMode: true }, appType: "custom" });
try {
  const { modules } = await server.ssrLoadModule("/src/app/modules.ts");
  const { resolveModule } = await server.ssrLoadModule("/src/app/router.ts");
  const { default: AppShell } = await server.ssrLoadModule("/src/app/AppShell.tsx");
  assert.ok(modules.length > 0);
  assert.equal(new Set(modules.map((module) => module.id)).size, modules.length);
  assert.equal(new Set(modules.map((module) => module.route)).size, modules.length);
  const shell = renderToStaticMarkup(createElement(AppShell));
  for (const module of modules) {
    assert.match(module.route, /^\/[a-z0-9-]+$/);
    assert.equal(resolveModule(`#${module.route}`), module);
    assert.ok(shell.includes(`href="#${module.route}"`));
    assert.ok(renderToStaticMarkup(createElement(module.component)).includes(`<h1>${module.name}</h1>`));
  }
  for (const hash of ["", "#", "#/"]) assert.equal(resolveModule(hash), modules[0]);
  for (const hash of ["#/missing", "#/git/extra", "#/%broken"]) assert.equal(resolveModule(hash), undefined);
  assert.equal((shell.match(/aria-current="page"/g) || []).length, 1);
  const { groupPortOwners } = await server.ssrLoadModule("/src/modules/ports/PortsPage.tsx");
  const owner = { pid: 20944, port: 3000, protocol: "TCP", address: "[::]", remoteAddress: null, state: "LISTENING", startedAt: "123" };
  const input = [owner, { ...owner, address: "0.0.0.0" }, owner,
    { ...owner, address: "127.0.0.1", state: "ESTABLISHED", remoteAddress: "203.0.113.7:443" },
    { ...owner, pid: 20945 }, { ...owner, port: 3001 }, { ...owner, protocol: "UDP" }];
  const grouped = groupPortOwners(input);
  assert.equal(grouped.length, 4);
  assert.deepEqual(grouped[0].endpoints, [
    { address: "[::]", remote: null, state: "LISTENING" },
    { address: "0.0.0.0", remote: null, state: "LISTENING" },
    { address: "127.0.0.1", remote: "203.0.113.7:443", state: "ESTABLISHED" },
  ]);
  assert.equal(grouped[0].startedAt, "123");
  assert.equal(owner.endpoints, undefined);
  assert.deepEqual(groupPortOwners([]), []);
  console.log("Architecture check passed: registry, navigation, pages, default and unknown routes.");
} finally {
  await server.close();
}
