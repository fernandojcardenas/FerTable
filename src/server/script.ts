// Automation script steps run in QuickJS, a separate JavaScript engine compiled to
// WebAssembly: no access to the server's files, network, environment or Node APIs.
// Each run gets fresh memory, a time limit and a memory limit.

import { getQuickJS, shouldInterruptAfterDeadline, type QuickJSWASMModule } from "quickjs-emscripten";

const TIME_LIMIT_MS = 1000;
const MEMORY_LIMIT = 16 * 1024 * 1024;
const MAX_LOG = 4000;

let quickjs: Promise<QuickJSWASMModule> | null = null;

export type ScriptResult = { ok: true; updates: Record<string, unknown> | null; log: string } | { ok: false; error: string; log: string };

/**
 * Run a script. It sees `record` (the current record: field name → value), `trigger`
 * (the record that started the run), and `console.log`. If it returns an object,
 * those field names are updated on the current record.
 */
export async function runScript(code: string, record: Record<string, unknown> | null, trigger: Record<string, unknown> | null): Promise<ScriptResult> {
  quickjs ??= getQuickJS();
  const QuickJS = await quickjs;
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(MEMORY_LIMIT);
  runtime.setMaxStackSize(512 * 1024);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + TIME_LIMIT_MS));
  const vm = runtime.newContext();
  let log = "";
  try {
    const logFn = vm.newFunction("log", (...args) => {
      const line = args.map((a) => { const v = vm.dump(a); return typeof v === "string" ? v : JSON.stringify(v); }).join(" ");
      if (log.length < MAX_LOG) log += (log ? "\n" : "") + line.slice(0, MAX_LOG - log.length);
    });
    const consoleObj = vm.newObject();
    vm.setProp(consoleObj, "log", logFn);
    vm.setProp(vm.global, "console", consoleObj);
    logFn.dispose();
    consoleObj.dispose();
    // Data goes in as JSON text and is parsed inside the sandbox, so no host objects leak in.
    const input = JSON.stringify({ record, trigger });
    const wrapped = `(function(){ const __in = JSON.parse(${JSON.stringify(input)}); const record = __in.record; const trigger = __in.trigger;\n${code}\n})()`;
    const result = vm.evalCode(wrapped, "automation-script.js");
    if (result.error) {
      const e = vm.dump(result.error) as { name?: string; message?: string } | string;
      result.error.dispose();
      const msg = typeof e === "string" ? e : e?.message === "interrupted" ? `The script ran longer than ${TIME_LIMIT_MS / 1000} s` : `${e?.name ?? "Error"}: ${e?.message ?? ""}`;
      return { ok: false, error: msg.slice(0, 500), log };
    }
    const out = vm.dump(result.value);
    result.value.dispose();
    const updates = out && typeof out === "object" && !Array.isArray(out) ? (out as Record<string, unknown>) : null;
    if (out !== undefined && !updates && log.length < MAX_LOG) log += (log ? "\n" : "") + `→ ${JSON.stringify(out)}`.slice(0, 500);
    return { ok: true, updates, log };
  } catch (e) {
    return { ok: false, error: `The script couldn't run: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500), log };
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}
