import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LyftaClient, LyftaApiError } from "./lyfta-client.js";

const RATE = "Rate limits: 60 req/min, 5000 req/day. All IDs are strings.";

// Single source of truth for the version: package.json sits next to dist/ at
// runtime (and one level up from src/ in dev), so this resolves in every mode.
const version = "0.3.1";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

async function runTool(apiKey: string, fn: (c: LyftaClient) => Promise<unknown>): Promise<ToolResult> {
  try {
    const data = await fn(new LyftaClient(apiKey));
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (e) {
    const msg =
      e instanceof LyftaApiError
        ? `Lyfta API error (${e.status}): ${e.message}${e.retryAfter ? ` [retry-after: ${e.retryAfter}]` : ""}`
        : e instanceof Error
          ? e.message
          : String(e);
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}

const numStr = z.union([z.string(), z.number()]);

const setSchema = z
  .object({
    set_type_id: numStr.optional(),
    reps: numStr.optional(),
    from_reps: numStr.optional(),
    to_reps: numStr.optional(),
    weight: numStr.optional(),
    rir: numStr.optional(),
    duration: numStr.optional(),
    distance: numStr.optional(),
  })
  .passthrough();

const exerciseSchema = z
  .object({
    exercise_id: numStr,
    excercise_name: z.string().optional(),
    exercise_type: z.string().optional(),
    exercise_image: z.string().optional(),
    exercise_rest_time: numStr.optional(),
    exercise_note: z.string().optional(),
    is_rep_range_active: z.union([z.boolean(), numStr]).optional(),
    sets: z.array(setSchema).optional(),
  })
  .passthrough();

const workoutSchema = z
  .object({
    title: z.string(),
    description: z.string().optional(),
    note: z.string().optional(),
    color: z.string().optional(),
    picture: z.string().optional(),
    exercises: z.array(exerciseSchema).default([]),
  })
  .passthrough();

/** Build a fully-configured MCP server with all Lyfta tools registered. */
export function createServer(apiKey: string): McpServer {
  const server = new McpServer({ name: "lyfta-mcp", version });

  server.registerTool(
    "list_workouts",
    {
      title: "List workouts",
      description: `Detailed workouts including exercises and sets, paginated (limit max 100). ${RATE}`,
      inputSchema: {
        page: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ page, limit }) => runTool(apiKey, (c) => c.listWorkouts({ page, limit })),
  );

  server.registerTool(
    "list_workout_summaries",
    {
      title: "List workout summaries",
      description: `Lightweight workout summaries (id, title, duration, total_volume, date), paginated (limit max 1000). ${RATE}`,
      inputSchema: {
        page: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      },
    },
    async ({ page, limit }) => runTool(apiKey, (c) => c.listWorkoutSummaries({ page, limit })),
  );

  server.registerTool(
    "list_exercises",
    {
      title: "List performed exercises",
      description: `Catalog of exercises the user has performed. Note: equipment/body-part/muscle IDs are returned as JSON-stringified arrays. ${RATE}`,
      inputSchema: {},
    },
    async () => runTool(apiKey, (c) => c.listExercises()),
  );

  server.registerTool(
    "search_exercise_library",
    {
      title: "Search exercise library",
      description: `Search Lyfta's exercise library by name. Returns catalog IDs and metadata needed to create templates. This is a read-only tool. ${RATE}`,
      inputSchema: {
        search: z.string().optional().describe("Exercise name or search phrase"),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    async ({ search, limit, offset }) =>
      runTool(apiKey, (c) => c.listExerciseLibrary({ search, limit, offset })),
  );

  server.registerTool(
    "list_collections",
    {
      title: "List collections",
      description: `List saved programs and collections. ${RATE}`,
      inputSchema: {
        page: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ page, limit }) => runTool(apiKey, (c) => c.listCollections({ page, limit })),
  );

  server.registerTool(
    "get_collection",
    {
      title: "Get collection",
      description: `Get one collection. Use view=full to include every workout template and its exercise data. ${RATE}`,
      inputSchema: {
        collection_id: z.string(),
        view: z.enum(["summary", "full"]).optional(),
      },
    },
    async ({ collection_id, view }) =>
      runTool(apiKey, (c) => c.getCollection(collection_id, view ?? "full")),
  );

  server.registerTool(
    "list_templates",
    {
      title: "List workout templates",
      description: `List saved workout template cards. ${RATE}`,
      inputSchema: {
        page: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ page, limit }) => runTool(apiKey, (c) => c.listTemplates({ page, limit })),
  );

  server.registerTool(
    "get_template",
    {
      title: "Get workout template",
      description: `Get one saved workout template, including exercises and sets. Useful for verifying custom exercise IDs and names. ${RATE}`,
      inputSchema: { template_id: z.string() },
    },
    async ({ template_id }) => runTool(apiKey, (c) => c.getTemplate(template_id)),
  );

  server.registerTool(
    "get_exercise_progress",
    {
      title: "Get exercise progress",
      description: `Progress over time for one exercise (best weight/reps/volume, estimated 1RM). ${RATE}`,
      inputSchema: {
        exercise_id: z.string().describe("Exercise id (string)"),
        duration: z.number().int().min(1).describe("Look-back window in days"),
      },
    },
    async ({ exercise_id, duration }) =>
      runTool(apiKey, (c) => c.getExerciseProgress({ exercise_id, duration })),
  );

  server.registerTool(
    "list_clients",
    {
      title: "List coaching clients",
      description: `Coach API: active coaching clients. Errors if the account is not a coach. ${RATE}`,
      inputSchema: {},
    },
    async () => runTool(apiKey, (c) => c.listClients()),
  );

  server.registerTool(
    "create_collection",
    {
      title: "Create collection/program",
      description: `Create a new program/collection. Coaches may target a client via client_id. ${RATE}`,
      inputSchema: {
        title: z.string().min(1),
        description: z.string().optional(),
        goal: z.string().optional(),
        image: z.string().optional().describe("base64-encoded image"),
        client_id: z.string().optional().describe("coach only"),
      },
    },
    async ({ title, description, goal, image, client_id }) =>
      runTool(apiKey, (c) =>
        c.createCollection({
          collection: { title, description, goal, image },
          ...(client_id ? { client_id } : {}),
        }),
      ),
  );

  server.registerTool(
    "create_template",
    {
      title: "Create workout template",
      description: `Create a workout template inside an existing collection. Coaches may target a client via clientId. ${RATE}`,
      inputSchema: {
        collectionId: z.string(),
        workout: workoutSchema,
        clientId: z.string().optional().describe("coach only"),
      },
    },
    async ({ collectionId, workout, clientId }) =>
      runTool(apiKey, (c) =>
        c.createTemplate({ collectionId, workout, ...(clientId ? { clientId } : {}) }),
      ),
  );

  return server;
}
