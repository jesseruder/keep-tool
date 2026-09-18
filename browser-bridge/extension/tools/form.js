// form_input: set a form field's value the way a user would.

import { requireTab } from "../lib/sessions.js";
import { setFormValue } from "../lib/page.js";
import { callOnRef } from "./shared.js";

export async function form_input(ctx, params = {}) {
  const tab = await requireTab(ctx.sessionKey, params.tabId);
  const ref = String(params.ref ?? "");
  if (!ref) throw new Error("ref is required");
  if (params.value === undefined) throw new Error("value is required");

  const { value } = await callOnRef(tab.id, ref, setFormValue, [params.value]);
  if (!value?.ok) throw new Error(value?.error ?? `Could not set a value on ${ref}`);
  return { text: `Set ${ref} (${value.kind}) to ${JSON.stringify(value.value)}.` };
}
