import { test } from "node:test";
import assert from "node:assert/strict";
import { choiceNames, detectDelimiter, importValue, inferColumn, neutralizeFormula, parseCsv, parseDate, parseNumber, toCsv } from "../src/shared/csv";
import { applyAction, applyActions, emptyBase } from "../src/shared/reducer";
import { newId } from "../src/shared/ids";
import type { Action } from "../src/shared/types";

test("parses quotes, escaped quotes, newlines in quotes, CRLF and a BOM", () => {
  const csv = '﻿Name,Notes,Amount\r\n"Smith, Ana","said ""hi""\nthen left",12\r\nBo,,3\r\n\r\n';
  assert.deepEqual(parseCsv(csv), [
    ["Name", "Notes", "Amount"],
    ["Smith, Ana", 'said "hi"\nthen left', "12"],
    ["Bo", "", "3"],
  ]);
});

test("detects semicolons and tabs", () => {
  assert.equal(detectDelimiter("a;b;c\n1;2;3\n"), ";");
  assert.equal(detectDelimiter("a\tb\n1\t2\n"), "\t");
  assert.equal(detectDelimiter('a,b\n"x;y",2\n'), ",");
  assert.deepEqual(parseCsv("a;b\n1;2\n"), [["a", "b"], ["1", "2"]]);
});

test("writes CSV that reads back the same", () => {
  const rows = [["Name", "Note"], ["Smith, Ana", 'a "quote"\nand a line']];
  const out = toCsv(rows);
  assert.ok(out.startsWith("﻿"));
  assert.deepEqual(parseCsv(out), rows);
});

test("text that would run as a spreadsheet formula is neutralized", () => {
  assert.equal(neutralizeFormula("=HYPERLINK(\"http://evil\")"), "'=HYPERLINK(\"http://evil\")");
  assert.equal(neutralizeFormula("+1"), "'+1");
  assert.equal(neutralizeFormula("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(neutralizeFormula("Plain"), "Plain");
});

test("numbers, money, percents and dates", () => {
  assert.equal(parseNumber("1,234.50"), 1234.5);
  assert.equal(parseNumber("$-5"), -5);
  assert.equal(parseNumber("(12)"), -12);
  assert.equal(parseNumber("45%"), 0.45);
  assert.equal(parseNumber("12abc"), null);
  assert.deepEqual(parseDate("2026-11-09"), { iso: "2026-11-09", hasTime: false });
  assert.deepEqual(parseDate("11/9/2026"), { iso: "2026-11-09", hasTime: false });
  assert.equal(parseDate("13/45/2026"), null);
});

test("guesses a sensible type for each column", () => {
  assert.equal(inferColumn(["1", "2", "30"]).type, "number");
  assert.deepEqual(inferColumn(["$1.50", "$20", "$3.25"]).options.format, "currency");
  assert.equal(inferColumn(["02134", "10001"]).type, "text", "leading zeros stay text");
  assert.equal(inferColumn(["yes", "no", "yes"]).type, "checkbox");
  assert.equal(inferColumn(["2026-01-02", "11/9/2026"]).type, "date");
  assert.equal(inferColumn(["a@b.co", "c@d.org"]).type, "email");
  assert.equal(inferColumn(["Todo", "Done", "Todo", "Doing", "Done", "Todo"]).type, "singleSelect");
  assert.equal(inferColumn(["Alpha", "Beta", "Gamma", "Delta"]).type, "text", "all-different values aren't a category");
  assert.equal(inferColumn(["", ""]).type, "text");
  assert.deepEqual(choiceNames(["Red, Blue", "blue", "Green"], true), ["Red", "Blue", "Green"]);
});

test("converts cells to stored values", () => {
  const choices = [{ id: "optAAAAAAAAAAAAAA", name: "Todo", color: "red" }];
  assert.equal(importValue("1,000", "number", {}), 1000);
  assert.equal(importValue("yes", "checkbox", {}), true);
  assert.equal(importValue("no", "checkbox", {}), null);
  assert.equal(importValue("11/9/2026", "date", {}), "2026-11-09");
  assert.equal(importValue("todo", "singleSelect", { choices }), "optAAAAAAAAAAAAAA");
  assert.equal(importValue("line1\nline2", "text", {}), "line1 line2");
  assert.equal(importValue("", "text", {}), null);
});

test("applying a batch at once matches applying it one by one, and is fast", () => {
  const t = newId("tbl"), name = newId("fld");
  const s0 = applyAction(emptyBase(newId("bas"), "B"), { type: "table.create", tableId: t, name: "T", primaryFieldId: name, viewId: newId("viw") });
  const ids = Array.from({ length: 5000 }, () => newId("rec"));
  const actions: Action[] = ids.map((rowId, i) => ({ type: "row.create", rowId, tableId: t, cells: { [name]: `Row ${i}` } }));
  const started = Date.now();
  const batch = applyActions(s0, actions, "2026-01-01T00:00:00.000Z");
  const ms = Date.now() - started;
  const oneByOne = actions.slice(0, 300).reduce((s, a) => applyAction(s, a, "2026-01-01T00:00:00.000Z"), s0);
  assert.deepEqual(applyActions(s0, actions.slice(0, 300), "2026-01-01T00:00:00.000Z"), oneByOne);
  assert.equal(batch.tables[t].rowOrder.length, 5000);
  assert.ok(ms < 2000, `5,000 rows took ${ms} ms`);
  assert.equal(s0.tables[t].rowOrder.length, 0, "the input state is untouched");
});
