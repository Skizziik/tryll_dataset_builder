#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Store } from "./lib/store.js";
import WebSocket from "ws";

const store = new Store(process.env.DATA_DIR);

const server = new Server(
  { name: "tryll-dataset-builder", version: "1.1.0" },
  { capabilities: { tools: {} } }
);

// ============================================
// SESSION CONNECTION STATE
// ============================================

let sessionWs = null;    // WebSocket to the web app
let sessionBase = null;  // e.g. "http://localhost:3000"
let sessionCode = null;  // e.g. "4F8K2M"

function isConnected() {
  return sessionWs && sessionWs.readyState === WebSocket.OPEN;
}

async function apiCall(method, path, body) {
  const url = `${sessionBase}${path}`;
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `API ${res.status}`);
  return data;
}

// ============================================
// TOOL DEFINITIONS
// ============================================

const TOOLS = [
  // ---- Session ----
  {
    name: "connect_session",
    description: "Connect to the Dataset Builder web app for real-time collaboration. After connecting, all operations will appear live in the browser. The user will give you a 6-character session code shown in the web app's topbar. Default server: https://trylljsoncreator.onrender.com",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "6-character session code shown in the web app's topbar" },
        url: { type: "string", description: "Web app URL. Default: https://trylljsoncreator.onrender.com. Only change if self-hosting." },
      },
      required: ["code"],
    },
  },
  {
    name: "disconnect_session",
    description: "Disconnect from the Dataset Builder web app. Operations will switch back to local file storage.",
    inputSchema: { type: "object", properties: {} },
  },

  // ---- Project ----
  {
    name: "create_project",
    description: "Create a new dataset project. Each project stores categories and chunks, exported as a single JSON file.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Project name (used as filename on export)" },
      },
      required: ["name"],
    },
  },
  {
    name: "list_projects",
    description: "List all existing dataset projects with basic stats (category count, chunk count).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "delete_project",
    description: "Permanently delete a project and all its data.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Project name to delete" },
      },
      required: ["name"],
    },
  },
  {
    name: "get_project_stats",
    description: "Get detailed statistics for a project: category names, total chunks, average text length, longest/shortest chunk.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Project name" },
      },
      required: ["name"],
    },
  },

  // ---- Category ----
  {
    name: "create_category",
    description: "Add a new category to a project. Categories organize chunks by topic (e.g. 'Mobs', 'Weapons', 'Biomes').",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name" },
        name: { type: "string", description: "Category name" },
      },
      required: ["project", "name"],
    },
  },
  {
    name: "list_categories",
    description: "List all categories in a project with chunk counts.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name" },
      },
      required: ["project"],
    },
  },
  {
    name: "rename_category",
    description: "Rename an existing category.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name" },
        old_name: { type: "string", description: "Current category name" },
        new_name: { type: "string", description: "New category name" },
      },
      required: ["project", "old_name", "new_name"],
    },
  },
  {
    name: "delete_category",
    description: "Delete a category and all its chunks.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name" },
        name: { type: "string", description: "Category name to delete" },
      },
      required: ["project", "name"],
    },
  },

  // ---- Chunk ----
  {
    name: "add_chunk",
    description: "Add a single knowledge chunk to a category. Each chunk has a unique ID, text content, and optional metadata (page_title, source, license, plus any custom fields).",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name" },
        category: { type: "string", description: "Category name" },
        id: { type: "string", description: "Unique chunk ID (e.g. 'creeper', 'diamond_sword')" },
        text: { type: "string", description: "Main text content of the chunk (knowledge entry)" },
        metadata: {
          type: "object",
          description: "Optional metadata. Standard fields: page_title, source, license. Any extra fields become custom metadata.",
          properties: {
            page_title: { type: "string" },
            source: { type: "string" },
            license: { type: "string" },
          },
          additionalProperties: { type: "string" },
        },
      },
      required: ["project", "category", "id", "text"],
    },
  },
  {
    name: "bulk_add_chunks",
    description: "Add multiple chunks at once to a category. Much faster than adding one by one. Skips chunks with duplicate IDs and reports errors.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name" },
        category: { type: "string", description: "Category name" },
        chunks: {
          type: "array",
          description: "Array of chunk objects, each with id, text, and optional metadata",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Unique chunk ID" },
              text: { type: "string", description: "Chunk text content" },
              metadata: { type: "object", additionalProperties: { type: "string" } },
            },
            required: ["id", "text"],
          },
        },
      },
      required: ["project", "category", "chunks"],
    },
  },
  {
    name: "get_chunk",
    description: "Get full content of a specific chunk by its ID.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name" },
        id: { type: "string", description: "Chunk ID" },
      },
      required: ["project", "id"],
    },
  },
  {
    name: "update_chunk",
    description: "Update fields of an existing chunk. Only provided fields will be changed.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name" },
        id: { type: "string", description: "Current chunk ID" },
        new_id: { type: "string", description: "New chunk ID (if renaming)" },
        text: { type: "string", description: "New text content" },
        page_title: { type: "string", description: "New page title" },
        source: { type: "string", description: "New source" },
        license: { type: "string", description: "New license" },
        metadata: { type: "object", description: "Custom metadata fields to update", additionalProperties: { type: "string" } },
      },
      required: ["project", "id"],
    },
  },
  {
    name: "delete_chunk",
    description: "Delete a chunk by its ID.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name" },
        id: { type: "string", description: "Chunk ID to delete" },
      },
      required: ["project", "id"],
    },
  },
  {
    name: "duplicate_chunk",
    description: "Create a copy of an existing chunk with a new ID (original_id + '_copy' suffix).",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name" },
        id: { type: "string", description: "Chunk ID to duplicate" },
      },
      required: ["project", "id"],
    },
  },
  {
    name: "move_chunk",
    description: "Move a chunk from its current category to a different one.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name" },
        id: { type: "string", description: "Chunk ID to move" },
        target_category: { type: "string", description: "Target category name" },
      },
      required: ["project", "id", "target_category"],
    },
  },

  // ---- Search & Export ----
  {
    name: "search_chunks",
    description: "Search for chunks by ID or text content across the entire project. Returns matching chunks with preview.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name" },
        query: { type: "string", description: "Search query (searches in chunk ID and text)" },
      },
      required: ["project", "query"],
    },
  },
  {
    name: "export_project",
    description: "Export the project as a flat JSON array — compatible with Dataset Builder web app and ready for RAG systems. Each entry has id, text, and metadata.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name" },
        save_to_file: { type: "boolean", description: "If true, saves to a .export.json file in the data directory. Default: false (returns JSON in response)." },
      },
      required: ["project"],
    },
  },
  {
    name: "import_json",
    description: "Import a JSON array of chunks into a project. Expected format: [{id, text, metadata}, ...]. Skips entries with duplicate IDs.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name (will be created if it doesn't exist)" },
        category: { type: "string", description: "Category to import into (default: 'Imported')" },
        json_path: { type: "string", description: "Absolute path to the JSON file to import" },
        data: { type: "array", description: "Or provide the JSON array directly instead of a file path", items: { type: "object" } },
      },
      required: ["project"],
    },
  },
];

// ============================================
// LIST TOOLS
// ============================================

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// ============================================
// REMOTE API HANDLERS (when connected to web app)
// ============================================

async function handleRemote(name, args) {
  const p = (n) => encodeURIComponent(n);
  const s = sessionCode;

  switch (name) {
    case "create_project":
      return apiCall('POST', '/api/projects', { name: args.name, session: s });
    case "list_projects":
      return apiCall('GET', '/api/projects');
    case "delete_project":
      return apiCall('DELETE', `/api/projects/${p(args.name)}?session=${s}`);
    case "get_project_stats":
      return apiCall('GET', `/api/projects/${p(args.name)}/stats`);
    case "create_category":
      return apiCall('POST', `/api/projects/${p(args.project)}/categories`, { name: args.name, session: s });
    case "list_categories":
      return apiCall('GET', `/api/projects/${p(args.project)}/categories`);
    case "rename_category":
      return apiCall('PUT', `/api/projects/${p(args.project)}/categories/${p(args.old_name)}`, { newName: args.new_name, session: s });
    case "delete_category":
      return apiCall('DELETE', `/api/projects/${p(args.project)}/categories/${p(args.name)}?session=${s}`);
    case "add_chunk":
      return apiCall('POST', `/api/projects/${p(args.project)}/categories/${p(args.category)}/chunks`, {
        id: args.id, text: args.text, metadata: args.metadata, session: s,
      });
    case "bulk_add_chunks":
      return apiCall('POST', `/api/projects/${p(args.project)}/categories/${p(args.category)}/chunks/bulk`, {
        chunks: args.chunks, session: s,
      });
    case "get_chunk": {
      const proj = await apiCall('GET', `/api/projects/${p(args.project)}`);
      for (const cat of proj.categories) {
        const ch = cat.chunks.find(c => c.id === args.id);
        if (ch) return { ...ch, category: cat.name };
      }
      throw new Error(`Chunk "${args.id}" not found`);
    }
    case "update_chunk": {
      const proj2 = await apiCall('GET', `/api/projects/${p(args.project)}`);
      for (const cat of proj2.categories) {
        const ch = cat.chunks.find(c => c.id === args.id);
        if (ch) {
          const body = { session: s };
          if (args.new_id !== undefined) body.id = args.new_id;
          if (args.text !== undefined) body.text = args.text;
          const meta = {};
          if (args.page_title !== undefined) meta.page_title = args.page_title;
          if (args.source !== undefined) meta.source = args.source;
          if (args.license !== undefined) meta.license = args.license;
          if (Object.keys(meta).length) body.metadata = meta;
          if (args.metadata) {
            body.customFields = Object.entries(args.metadata).map(([key, value]) => ({ key, value: String(value ?? '') }));
          }
          return apiCall('PUT', `/api/projects/${p(args.project)}/categories/${cat.id}/chunks/${ch._uid}`, body);
        }
      }
      throw new Error(`Chunk "${args.id}" not found`);
    }
    case "delete_chunk": {
      const proj3 = await apiCall('GET', `/api/projects/${p(args.project)}`);
      for (const cat of proj3.categories) {
        const ch = cat.chunks.find(c => c.id === args.id);
        if (ch) {
          return apiCall('DELETE', `/api/projects/${p(args.project)}/categories/${cat.id}/chunks/${ch._uid}?session=${s}`);
        }
      }
      throw new Error(`Chunk "${args.id}" not found`);
    }
    case "duplicate_chunk": {
      const proj4 = await apiCall('GET', `/api/projects/${p(args.project)}`);
      for (const cat of proj4.categories) {
        const ch = cat.chunks.find(c => c.id === args.id);
        if (ch) {
          return apiCall('POST', `/api/projects/${p(args.project)}/categories/${cat.id}/chunks/${ch._uid}/duplicate`);
        }
      }
      throw new Error(`Chunk "${args.id}" not found`);
    }
    case "move_chunk":
      return apiCall('POST', `/api/projects/${p(args.project)}/chunks/${p(args.id)}/move`, {
        targetCategory: args.target_category, session: s,
      });
    case "search_chunks":
      return apiCall('GET', `/api/projects/${p(args.project)}/search?q=${encodeURIComponent(args.query)}`);
    case "export_project":
      return apiCall('GET', `/api/projects/${p(args.project)}/export`);
    case "import_json": {
      let jsonData = args.data;
      if (!jsonData && args.json_path) {
        const { readFileSync } = await import('fs');
        jsonData = JSON.parse(readFileSync(args.json_path, 'utf-8'));
      }
      if (!jsonData) throw new Error('Provide either "json_path" or "data" parameter');
      return apiCall('POST', `/api/projects/${p(args.project)}/import`, {
        data: jsonData, category: args.category, session: s,
      });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ============================================
// CALL TOOL
// ============================================

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;

    // ---- Session tools ----
    if (name === "connect_session") {
      if (isConnected()) {
        sessionWs.close();
        sessionWs = null;
      }

      const base = (args.url || 'https://trylljsoncreator.onrender.com').replace(/\/+$/, '');
      const code = args.code.toUpperCase().trim();

      // Test the connection with a health check
      const health = await fetch(`${base}/health`).then(r => r.json()).catch(() => null);
      if (!health) throw new Error(`Cannot reach ${base}. Is the Dataset Builder server running?`);

      // Open WebSocket
      const wsProto = base.startsWith('https') ? 'wss' : 'ws';
      const wsHost = base.replace(/^https?:\/\//, '');
      const wsUrl = `${wsProto}://${wsHost}/ws?session=${code}&type=mcp`;

      await new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timer = setTimeout(() => { ws.close(); reject(new Error('Connection timed out')); }, 5000);

        ws.on('open', () => {
          clearTimeout(timer);
        });

        ws.on('message', (raw) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg.event === 'connected') {
              sessionWs = ws;
              sessionBase = base;
              sessionCode = code;
              resolve();
            } else if (msg.event === 'error') {
              clearTimeout(timer);
              ws.close();
              reject(new Error(msg.data?.message || 'Connection rejected'));
            }
          } catch {}
        });

        ws.on('error', (err) => {
          clearTimeout(timer);
          reject(new Error(`WebSocket error: ${err.message}`));
        });

        ws.on('close', () => {
          if (!sessionWs) {
            clearTimeout(timer);
            reject(new Error('Connection closed unexpectedly'));
          }
        });
      });

      // Handle unexpected disconnects
      sessionWs.on('close', () => {
        console.error('Disconnected from web app');
        sessionWs = null;
        sessionBase = null;
        sessionCode = null;
      });

      result = { connected: true, session: code, server: base };

    } else if (name === "disconnect_session") {
      if (sessionWs) {
        sessionWs.close();
        sessionWs = null;
        sessionBase = null;
        sessionCode = null;
      }
      result = { disconnected: true };

    } else if (isConnected()) {
      // ---- Remote mode: proxy through web app API ----
      result = await handleRemote(name, args);

    } else {
      // ---- Local mode: use local store ----
      switch (name) {
        case "create_project":
          result = store.createProject(args.name);
          break;
        case "list_projects":
          result = store.listProjects();
          break;
        case "delete_project":
          result = store.deleteProject(args.name);
          break;
        case "get_project_stats":
          result = store.getStats(args.name);
          break;
        case "create_category":
          result = store.createCategory(args.project, args.name);
          break;
        case "list_categories":
          result = store.listCategories(args.project);
          break;
        case "rename_category":
          result = store.renameCategory(args.project, args.old_name, args.new_name);
          break;
        case "delete_category":
          result = store.deleteCategory(args.project, args.name);
          break;
        case "add_chunk":
          result = store.addChunk(args.project, args.category, {
            id: args.id, text: args.text, metadata: args.metadata,
          });
          break;
        case "bulk_add_chunks":
          result = store.bulkAddChunks(args.project, args.category, args.chunks);
          break;
        case "get_chunk":
          result = store.getChunk(args.project, args.id);
          break;
        case "update_chunk":
          result = store.updateChunk(args.project, args.id, {
            newId: args.new_id, text: args.text, page_title: args.page_title,
            source: args.source, license: args.license, metadata: args.metadata,
          });
          break;
        case "delete_chunk":
          result = store.deleteChunk(args.project, args.id);
          break;
        case "duplicate_chunk":
          result = store.duplicateChunk(args.project, args.id);
          break;
        case "move_chunk":
          result = store.moveChunk(args.project, args.id, args.target_category);
          break;
        case "search_chunks":
          result = store.searchChunks(args.project, args.query);
          break;

        case "export_project": {
          const exported = store.exportProject(args.project);
          if (args.save_to_file) {
            const outPath = store._filePath(args.project).replace('.json', '.export.json');
            const { writeFileSync } = await import('fs');
            writeFileSync(outPath, JSON.stringify(exported, null, 2), 'utf-8');
            result = { exported: exported.length, savedTo: outPath };
          } else {
            result = { exported: exported.length, data: exported };
          }
          break;
        }

        case "import_json": {
          let jsonData = args.data;
          if (!jsonData && args.json_path) {
            const { readFileSync } = await import('fs');
            jsonData = JSON.parse(readFileSync(args.json_path, 'utf-8'));
          }
          if (!jsonData) throw new Error('Provide either "json_path" or "data" parameter');
          result = store.importJSON(args.project, jsonData, args.category);
          break;
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };

  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

// ============================================
// START
// ============================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Tryll Dataset Builder MCP server running (v1.1.0)");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
