import { PRESETS, presetName, pushScreen } from "../screen";
import { ArgError, defineTool, str } from "./types";

export default defineTool({
  name: "set_preset",
  description: "Switch the whole TV layout to a preset.",
  parameters: {
    type: "object",
    properties: { preset: { type: "string", enum: [...PRESETS] } },
    required: ["preset"],
    additionalProperties: false,
  },
  parse: (raw) => {
    const preset = presetName(str(raw, "preset", 40));
    if (!preset) throw new ArgError(`preset must be one of ${PRESETS.join(", ")}`);
    return { preset };
  },
  run: ({ preset }, ctx) => pushScreen({ op: "set_preset", preset }, { dryRun: ctx.dryRun }),
});
