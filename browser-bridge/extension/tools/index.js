// The dispatch table the service worker hands each incoming request to.
//
// browser_batch and the screenshot save_to_disk flag live in the MCP server: both are
// pure orchestration and need no browser.

import { computer } from "./computer.js";
import { file_upload, upload_image } from "./upload.js";
import { find, get_page_text, read_page } from "./read.js";
import { form_input } from "./form.js";
import { gif_creator } from "./gif.js";
import { javascript_tool } from "./js.js";
import { navigate } from "./navigate.js";
import { read_console_messages, read_network_requests } from "./logs.js";
import { browser_status } from "./status.js";
import { resize_window, tabs_close_mcp, tabs_context_mcp, tabs_create_mcp } from "./tabs.js";

export const handlers = {
  browser_status,
  computer,
  file_upload,
  find,
  form_input,
  get_page_text,
  gif_creator,
  javascript_tool,
  navigate,
  read_console_messages,
  read_network_requests,
  read_page,
  resize_window,
  tabs_close_mcp,
  tabs_context_mcp,
  tabs_create_mcp,
  upload_image,
};

export function handlerFor(method) {
  return Object.prototype.hasOwnProperty.call(handlers, method) ? handlers[method] : null;
}
