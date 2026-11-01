import type { Info as ToolInfo } from "@opencode/plugin/promise/tool";
import { createAdvanceTool } from "./advance";
import { createLessonTool } from "./lesson";
import { createLoopTool } from "./loop";
import { createNoteTool } from "./note";
import { createRewindTool } from "./rewind";
import { createStackTools } from "./stack";
import { createStartTool } from "./start";
import { createStatusTool } from "./status";
import type { ToolRuntime } from "./runtime";

export function createTeamTools(runtime: ToolRuntime): readonly ToolInfo[] {
  return [
    createStartTool(runtime),
    createStatusTool(runtime),
    createAdvanceTool(runtime),
    createLessonTool(runtime),
    createRewindTool(runtime),
    createLoopTool(runtime),
    createNoteTool(runtime),
    ...createStackTools(runtime),
  ];
}

export type { ToolRuntime } from "./runtime";
