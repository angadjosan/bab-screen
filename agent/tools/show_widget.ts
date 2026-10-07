import { pushScreen, readScreen } from "../screen";
import { defineTool, str } from "./types";

export default defineTool({
  name: "show_widget",
  description: "Put a widget in a slot on the TV. Slot and widget names come from the screen state in your context; the TV rejects unknown ones and says which are valid.",
  parameters: {
    type: "object",
    properties: {
      slot: { type: "string", description: "Slot name" },
      widget: { type: "string", description: "Widget name" },
    },
    required: ["slot", "widget"],
    additionalProperties: false,
  },
  parse: (raw) => ({ slot: str(raw, "slot", 40), widget: str(raw, "widget", 40) }),
  run: async ({ slot, widget }, ctx) => {
    const result = await pushScreen({ op: "show_widget", slot, widget }, { dryRun: ctx.dryRun });
    // On a refusal, hand back the current layout so the model can pick a real slot or widget.
    return result.ok ? result : { ...result, screen: await readScreen() };
  },
});
