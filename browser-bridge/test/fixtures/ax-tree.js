// A hand-written Accessibility.getFullAXTree payload shaped like a small shop page:
// an ignored wrapper, a search box with a value, a focused button with a text child,
// a main region, a deep nesting chain for the depth tests, and an iframe.

function node(nodeId, role, options = {}) {
  const { name, value, childIds = [], backendDOMNodeId, ignored = false, properties = [], description } = options;
  const axNode = { nodeId, role: { type: "role", value: role }, childIds, ignored };
  if (name !== undefined) axNode.name = { type: "computedString", value: name };
  if (value !== undefined) axNode.value = { type: "string", value };
  if (description !== undefined) axNode.description = { type: "computedString", value: description };
  if (backendDOMNodeId !== undefined) axNode.backendDOMNodeId = backendDOMNodeId;
  if (properties.length) {
    axNode.properties = properties.map(([propertyName, propertyValue]) => ({
      name: propertyName,
      value: { type: typeof propertyValue === "boolean" ? "boolean" : "string", value: propertyValue },
    }));
  }
  return axNode;
}

export const AX_TREE = [
  node("1", "RootWebArea", { name: "Example Shop", childIds: ["2"], backendDOMNodeId: 1 }),
  node("2", "generic", { childIds: ["3", "4", "10", "20"], backendDOMNodeId: 2, ignored: true }),
  node("3", "searchbox", {
    name: "Search products",
    value: "mango",
    backendDOMNodeId: 3,
    properties: [["focusable", true]],
  }),
  node("4", "button", {
    name: "Sign in",
    childIds: ["5"],
    backendDOMNodeId: 4,
    properties: [["focusable", true], ["focused", true]],
  }),
  node("5", "StaticText", { name: "Sign in", backendDOMNodeId: 5 }),
  node("10", "main", { name: "Products", childIds: ["11", "12", "13", "15"], backendDOMNodeId: 10 }),
  node("11", "heading", { name: "Organic mango", backendDOMNodeId: 11, properties: [["level", "1"]] }),
  node("12", "link", {
    name: "Add to cart",
    backendDOMNodeId: 12,
    description: "Adds the organic mango to your basket",
    properties: [["focusable", true]],
  }),
  node("13", "checkbox", {
    name: "Gift wrap",
    childIds: ["14"],
    backendDOMNodeId: 13,
    properties: [["focusable", true], ["checked", "false"]],
  }),
  node("14", "StaticText", { name: "Gift wrap this order", backendDOMNodeId: 14 }),
  // A chain deep enough to exercise the depth limit.
  node("15", "generic", { childIds: ["16"], backendDOMNodeId: 15 }),
  node("16", "generic", { childIds: ["17"], backendDOMNodeId: 16 }),
  node("17", "generic", { childIds: ["18"], backendDOMNodeId: 17 }),
  node("18", "button", { name: "Deeply nested", backendDOMNodeId: 18, properties: [["focusable", true]] }),
  node("20", "Iframe", { name: "Payment form", backendDOMNodeId: 20 }),
];

/** Many similar buttons, for the "more than 20 matches" path in find. */
export function manyButtons(count = 30) {
  const nodes = [node("r", "RootWebArea", { name: "List", childIds: [], backendDOMNodeId: 900 })];
  const childIds = [];
  for (let index = 0; index < count; index++) {
    const id = `b${index}`;
    childIds.push(id);
    nodes.push(
      node(id, "button", {
        name: `Delete item ${index}`,
        backendDOMNodeId: 1000 + index,
        properties: [["focusable", true]],
      }),
    );
  }
  nodes[0].childIds = childIds;
  return nodes;
}
