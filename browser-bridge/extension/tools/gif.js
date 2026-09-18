// gif_creator is phase 2. It is registered so the tool list matches Claude in Chrome,
// and it fails loudly rather than pretending to record.

export const NOT_IMPLEMENTED =
  "gif_creator is not implemented yet in Browser Bridge (phase 2). Use the computer tool's screenshot action for stills.";

export async function gif_creator() {
  throw new Error(NOT_IMPLEMENTED);
}
