import { describe, expect, test } from "bun:test";
import { ApiError } from "@/lib/api/client";
import {
  canAddRow,
  canRemoveRow,
  checkDraft,
  displayAnswer,
  emptyRow,
  firstIssuePath,
  hasNoOptions,
  initialDraft,
  inputErrorKind,
  inputNeedsRefresh,
  INPUT_ERROR_KINDS,
  localizeIssue,
  mapIssues,
  splitByImportance,
  toSubmission,
  type InputDraft,
} from "./input-form";
import { inputForm } from "./test-fixtures";
import en from "@/messages/en/ai.json";
import es from "@/messages/es/ai.json";

const form = inputForm();
const group = form.groups[0]!;

function filled(): InputDraft {
  const draft = initialDraft(form);
  draft.values.site = "loc1";
  draft.groups.items = [{ serial: "SN1", owner: "" }];
  return draft;
}

describe("initialDraft", () => {
  test("every field has an empty value of its kind; a group starts at its minimum, at least one row", () => {
    const draft = initialDraft(form);
    expect(draft.values).toEqual({ site: "", count: "", arrival: "", notes: "", tags: [], urgent: false });
    expect(draft.groups.items).toEqual([{ serial: "", owner: "" }]);
    const zero = initialDraft(inputForm({ groups: [{ ...group, minRows: 0 }] }));
    expect(zero.groups.items).toHaveLength(1);
    const three = initialDraft(inputForm({ groups: [{ ...group, minRows: 3, maxRows: 3 }] }));
    expect(three.groups.items).toHaveLength(3);
  });

  test("rows can be added up to maxRows and removed down to minRows", () => {
    expect(canAddRow(group, 2)).toBe(true);
    expect(canAddRow(group, 3)).toBe(false);
    expect(canRemoveRow(group, 1)).toBe(false);
    expect(canRemoveRow(group, 2)).toBe(true);
  });
});

describe("toSubmission", () => {
  test("blank values are left out, numbers are sent as numbers, a checkbox always as a boolean", () => {
    const draft = filled();
    draft.values.count = " 4 ";
    draft.values.tags = ["new"];
    const { body } = toSubmission(form, draft);
    expect(body).toEqual({
      action: "submit",
      values: { site: "loc1", count: 4, tags: ["new"], urgent: false },
      groups: { items: [{ serial: "SN1" }] },
    });
  });

  test("an unparsable number is sent as typed so the check reports it on its field", () => {
    const draft = filled();
    draft.values.count = "four";
    expect(toSubmission(form, draft).body.values?.count).toBe("four");
  });

  test("untouched extra rows are dropped and the row index maps back to the draft", () => {
    const draft = filled();
    draft.groups.items = [emptyRow(group.fields), { serial: "SN2", owner: "" }, emptyRow(group.fields)];
    const plan = toSubmission(form, draft);
    expect(plan.body.groups?.items).toEqual([{ serial: "SN2" }]);
    expect(plan.rowIndex.items).toEqual([1]);
  });

  test("when dropping blank rows would go below minRows, every row is sent", () => {
    const draft = filled();
    draft.groups.items = [emptyRow(group.fields)];
    const plan = toSubmission(form, draft);
    expect(plan.body.groups?.items).toEqual([{}]);
    expect(plan.rowIndex.items).toEqual([0]);
  });
});

describe("checkDraft", () => {
  test("a valid draft gives the body and the normalized answer", () => {
    const result = checkDraft(form, filled());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.answer).toEqual({ values: { site: "loc1", urgent: false }, groups: { items: [{ serial: "SN1" }] } });
  });

  test("the shared check's issues land on the draft's fields and rows", () => {
    const draft = initialDraft(form);
    draft.values.count = "99";
    draft.groups.items = [emptyRow(group.fields), { serial: "", owner: "Ana" }];
    const result = checkDraft(form, draft);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues["values.site"]).toBe("This field is required");
    expect(result.issues["values.count"]).toBe("At most 50");
    // The blank first row was dropped: the sent row 0 is draft row 1.
    expect(result.issues["groups.items.1.serial"]).toBe("This field is required");
    expect(result.issues["groups.items.0.serial"]).toBeUndefined();
    expect(firstIssuePath(form, draft, result.issues)).toBe("values.site");
  });
});

describe("mapIssues", () => {
  test("server paths map through the row index; unknown shapes go to the form", () => {
    const issues = mapIssues(
      [
        { path: "values.site", message: "Not one of the offered options" },
        { path: "groups.items", message: "Between 1 and 3 rows" },
        { path: "groups.items.0.serial", message: "This field is required" },
        { path: "values.site", message: "second message is ignored" },
        { path: "weird", message: "Something" },
      ],
      { items: [2] },
    );
    expect(issues).toEqual({
      "values.site": "Not one of the offered options",
      "groups.items": "Between 1 and 3 rows",
      "groups.items.2.serial": "This field is required",
      form: "Something",
    });
  });
});

describe("importance and options", () => {
  test("optional fields are split off; required and recommended stay up front", () => {
    const { primary, optional } = splitByImportance(form.fields);
    expect(primary.map((f) => f.key)).toEqual(["site", "count"]);
    expect(optional.map((f) => f.key)).toEqual(["arrival", "notes", "tags", "urgent"]);
  });

  test("a select without options is flagged", () => {
    expect(hasNoOptions({ ...form.fields[0]!, options: [] })).toBe(true);
    expect(hasNoOptions(form.fields[0]!)).toBe(false);
    expect(hasNoOptions(form.fields[1]!)).toBe(false);
  });
});

describe("displayAnswer", () => {
  test("options show by label, never by id; blanks read as empty", () => {
    const [site, count, arrival, , tags, urgent] = form.fields;
    expect(displayAnswer(site!, "loc2")).toEqual({ kind: "text", text: "Warehouse" });
    expect(displayAnswer(site!, "gone")).toEqual({ kind: "text", text: "gone" });
    expect(displayAnswer(tags!, ["new", "leased"])).toEqual({ kind: "list", items: ["New", "Leased"] });
    expect(displayAnswer(count!, 4)).toEqual({ kind: "number", value: 4 });
    expect(displayAnswer(arrival!, "2026-10-01")).toEqual({ kind: "date", day: "2026-10-01" });
    expect(displayAnswer(urgent!, true)).toEqual({ kind: "boolean", value: true });
    expect(displayAnswer(site!, undefined)).toEqual({ kind: "empty" });
    expect(displayAnswer(tags!, [])).toEqual({ kind: "empty" });
  });
});

describe("inputErrorKind", () => {
  const err = (status: number, body: unknown) => new ApiError(status, "refused", body, "req-1");

  test("maps each refusal", () => {
    expect(
      inputErrorKind(
        err(400, { code: "INVALID_INPUT", issues: [{ path: "values.site", message: "x" }, { bad: 1 }] }),
      ),
    ).toEqual({ kind: "invalid", issues: [{ path: "values.site", message: "x" }] });
    expect(inputErrorKind(err(409, { code: "RUN_NOT_AWAITING_INPUT" }))).toEqual({ kind: "notAwaiting" });
    expect(inputErrorKind(err(409, { code: "EXPIRED" }))).toEqual({ kind: "expired" });
    expect(inputErrorKind(err(409, { code: "AI_DISABLED" }))).toEqual({ kind: "aiDisabled" });
    expect(inputErrorKind(err(403, { code: "FORBIDDEN" }))).toEqual({ kind: "forbidden" });
    expect(inputErrorKind(err(404, { code: "NOT_FOUND" }))).toEqual({ kind: "notFound" });
    expect(inputErrorKind(err(500, {}))).toEqual({ kind: "unknown", requestId: "req-1" });
    expect(inputErrorKind(new Error("offline"))).toEqual({ kind: "unknown" });
  });

  test("answered elsewhere or expired re-reads the card", () => {
    expect(inputNeedsRefresh({ kind: "notAwaiting" })).toBe(true);
    expect(inputNeedsRefresh({ kind: "expired" })).toBe(true);
    expect(inputNeedsRefresh({ kind: "invalid", issues: [] })).toBe(false);
  });

  test("every kind has a message in both catalogs", () => {
    for (const kind of INPUT_ERROR_KINDS) {
      expect(typeof (en.input.errors as Record<string, string>)[kind]).toBe("string");
      expect(typeof (es.input.errors as Record<string, string>)[kind]).toBe("string");
    }
  });
});

describe("localizeIssue", () => {
  test("recognizes the shared check's messages", () => {
    expect(localizeIssue("This field is required")).toEqual({ key: "required" });
    expect(localizeIssue("At most 500 characters")).toEqual({ key: "maxChars", values: { max: 500 } });
    expect(localizeIssue("At least 1")).toEqual({ key: "min", values: { min: "1" } });
    expect(localizeIssue("At most 50")).toEqual({ key: "max", values: { max: "50" } });
    expect(localizeIssue("Between 1 and 3 rows")).toEqual({ key: "rows", values: { min: 1, max: 3 } });
    expect(localizeIssue("Not a valid date value")).toEqual({ key: "invalid" });
    expect(localizeIssue("Not one of the offered options")).toEqual({ key: "notOffered" });
    expect(localizeIssue("Unknown group")).toEqual({ key: "unknown" });
    expect(localizeIssue("Something new")).toBeNull();
  });
});
