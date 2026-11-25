// DoD template contract (part of `STAGE_R0_CONTRACTS` in `./rpc`).
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { ProjectInput, result } from "./rpc-base";

export const DodTemplateValue = z.object({
  source: z.enum(["file", "project", "global", "none"]),
  text: z.string(),
});
export type DodTemplateValue = z.infer<typeof DodTemplateValue>;

export const DodTemplateGet = defineRpc({
  name: "dod.template.get",
  input: ProjectInput,
  output: result(DodTemplateValue),
});
