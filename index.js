#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Store } from "./lib/store.js";
import WebSocket from "ws";
import * as cheerio from "cheerio";

const store = new Store(process.env.DATA_DIR);

const server = new Server(
  { name: "tryll-dataset-builder", version: "1.3.0" },
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
// URL PARSING HELPERS
// ============================================

const CHUNK_LIMIT = 2000;

async function parseUrl(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TryllDatasetBuilder/1.2)' },
  });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  // Extract page title
  const pageTitle = $('title').first().text().trim()
    || $('h1').first().text().trim()
    || '';

  // Extract wiki infobox metadata
  const infobox = {};
  $('.infobox tr, .sidebar tr, .wikitable.infobox tr, table.infobox tr').each((_, row) => {
    const $row = $(row);
    const key = $row.find('th').first().text().trim().replace(/\s+/g, ' ');
    const val = $row.find('td').first().text().trim().replace(/\s+/g, ' ');
    if (key && val && key.length < 60 && val.length < 200) {
      infobox[key] = val;
    }
  });

  // Remove noise elements
  $('script, style, nav, footer, header, .sidebar, .infobox, .navbox, .mw-editsection, .reference, .reflist, #mw-navigation, .noprint, .toc').remove();

  // Extract main text
  const mainContent = $('article, main, #mw-content-text, #content, .mw-parser-output, #bodyContent, .entry-content, .post-content').first();
  let text = '';
  if (mainContent.length) {
    text = mainContent.text();
  } else {
    text = $('body').text();
  }

  // Clean up whitespace
  text = text
    .replace(/\t/g, ' ')
    .replace(/[ ]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { text, pageTitle, infobox, source: url };
}

function splitTextIntoChunks(text, baseId, limit = CHUNK_LIMIT) {
  if (text.length <= limit) {
    return [{ id: baseId, text }];
  }

  const chunks = [];
  let remaining = text;
  let index = 1;

  while (remaining.length > 0) {
    let cutPoint = limit;
    if (remaining.length > limit) {
      // Try to cut at paragraph boundary
      const paraBreak = remaining.lastIndexOf('\n\n', limit);
      if (paraBreak > limit * 0.3) {
        cutPoint = paraBreak;
      } else {
        // Try sentence boundary
        const sentBreak = remaining.lastIndexOf('. ', limit);
        if (sentBreak > limit * 0.3) {
          cutPoint = sentBreak + 1;
        }
      }
    } else {
      cutPoint = remaining.length;
    }

    chunks.push({
      id: `${baseId}_${index}`,
      text: remaining.substring(0, cutPoint).trim(),
    });
    remaining = remaining.substring(cutPoint).trim();
    index++;
  }

  return chunks;
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

  // ---- URL Parsing ----
  {
    name: "parse_url",
    description: "Fetch a web page, extract its text content, and auto-create chunks. If text exceeds 2000 characters, it auto-splits into multiple chunks with _1, _2 suffixes. Extracts page title and source URL as metadata. For wiki pages, extracts infobox/sidebar data as custom metadata fields.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name" },
        category: { type: "string", description: "Category to add chunks into" },
        url: { type: "string", description: "URL to fetch and parse" },
        chunk_id: { type: "string", description: "Base chunk ID. If text is split, becomes chunk_id_1, chunk_id_2, etc." },
        license: { type: "string", description: "License for the content. Default: CC BY-NC-SA 3.0" },
      },
      required: ["project", "category", "url", "chunk_id"],
    },
  },
  {
    name: "batch_parse_urls",
    description: "Parse multiple URLs at once and add all chunks to a category. Each URL gets its own chunk ID prefix. Auto-splits long texts into multiple chunks.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name" },
        category: { type: "string", description: "Category to add chunks into" },
        urls: {
          type: "array",
          description: "Array of URL entries to parse",
          items: {
            type: "object",
            properties: {
              url: { type: "string", description: "URL to fetch" },
              chunk_id: { type: "string", description: "Base chunk ID for this URL" },
            },
            required: ["url", "chunk_id"],
          },
        },
        license: { type: "string", description: "License for all content. Default: CC BY-NC-SA 3.0" },
      },
      required: ["project", "category", "urls"],
    },
  },

  // ---- Bulk Operations ----
  {
    name: "bulk_update_metadata",
    description: "Update a metadata field across ALL chunks in a project (or a specific category). Useful for setting license, source, or custom fields in bulk.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name" },
        field: { type: "string", description: "Metadata field to update (e.g. 'license', 'source', or any custom field name)" },
        value: { type: "string", description: "New value for the field" },
        category: { type: "string", description: "Optional: only update chunks in this category. If omitted, updates all chunks in the project." },
      },
      required: ["project", "field", "value"],
    },
  },
  {
    name: "merge_projects",
    description: "Merge all categories and chunks from a source project into a target project. Categories with the same name are combined. Chunks with duplicate IDs are skipped.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Source project name (data is copied FROM here)" },
        target: { type: "string", description: "Target project name (data is merged INTO here)" },
      },
      required: ["source", "target"],
    },
  },
  {
    name: "export_category",
    description: "Export a single category as a flat JSON array. Same format as export_project but filtered to one category.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name" },
        category: { type: "string", description: "Category name to export" },
        save_to_file: { type: "boolean", description: "If true, saves to a file. Default: false." },
      },
      required: ["project", "category"],
    },
  },

  // ---- History ----
  {
    name: "get_history",
    description: "Get version history (last 50 commits) for a project. Each commit shows who made the change (browser/MCP), what was changed, and when. Returns lightweight list without snapshots.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name" },
      },
      required: ["project"],
    },
  },
  {
    name: "get_commit",
    description: "Get a specific commit with full snapshot data. Returns the commit's snapshot and the previous commit's snapshot for computing diffs.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name" },
        commit_id: { type: "string", description: "Commit UUID" },
      },
      required: ["project", "commit_id"],
    },
  },
  {
    name: "rollback",
    description: "Rollback a project to a specific commit's state. Restores the project data from that commit's snapshot and creates a new 'rollback' commit in history. Safe: you can undo a rollback by rolling back to a later commit.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name" },
        commit_id: { type: "string", description: "Commit UUID to rollback to" },
      },
      required: ["project", "commit_id"],
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
      return apiCall('POST', '/api/projects', { name: args.name, session: s, source: 'mcp' });
    case "list_projects":
      return apiCall('GET', '/api/projects');
    case "delete_project":
      return apiCall('DELETE', `/api/projects/${p(args.name)}?session=${s}&source=mcp`);
    case "get_project_stats":
      return apiCall('GET', `/api/projects/${p(args.name)}/stats`);
    case "create_category":
      return apiCall('POST', `/api/projects/${p(args.project)}/categories`, { name: args.name, session: s, source: 'mcp' });
    case "list_categories":
      return apiCall('GET', `/api/projects/${p(args.project)}/categories`);
    case "rename_category":
      return apiCall('PUT', `/api/projects/${p(args.project)}/categories/${p(args.old_name)}`, { newName: args.new_name, session: s, source: 'mcp' });
    case "delete_category":
      return apiCall('DELETE', `/api/projects/${p(args.project)}/categories/${p(args.name)}?session=${s}&source=mcp`);
    case "add_chunk":
      return apiCall('POST', `/api/projects/${p(args.project)}/categories/${p(args.category)}/chunks`, {
        id: args.id, text: args.text, metadata: args.metadata, session: s, source: 'mcp',
      });
    case "bulk_add_chunks":
      return apiCall('POST', `/api/projects/${p(args.project)}/categories/${p(args.category)}/chunks/bulk`, {
        chunks: args.chunks, session: s, source: 'mcp',
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
          const body = { session: s, source: 'mcp' };
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
          return apiCall('DELETE', `/api/projects/${p(args.project)}/categories/${cat.id}/chunks/${ch._uid}?session=${s}&source=mcp`);
        }
      }
      throw new Error(`Chunk "${args.id}" not found`);
    }
    case "duplicate_chunk": {
      const proj4 = await apiCall('GET', `/api/projects/${p(args.project)}`);
      for (const cat of proj4.categories) {
        const ch = cat.chunks.find(c => c.id === args.id);
        if (ch) {
          return apiCall('POST', `/api/projects/${p(args.project)}/categories/${cat.id}/chunks/${ch._uid}/duplicate`, { source: 'mcp' });
        }
      }
      throw new Error(`Chunk "${args.id}" not found`);
    }
    case "move_chunk":
      return apiCall('POST', `/api/projects/${p(args.project)}/chunks/${p(args.id)}/move`, {
        targetCategory: args.target_category, session: s, source: 'mcp',
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
        data: jsonData, category: args.category, session: s, source: 'mcp',
      });
    }
    case "parse_url": {
      const parsed = await parseUrl(args.url);
      const chunks = splitTextIntoChunks(parsed.text, args.chunk_id);
      const license = args.license || 'CC BY-NC-SA 3.0';
      const chunkData = chunks.map(ch => ({
        id: ch.id, text: ch.text,
        metadata: { page_title: parsed.pageTitle, source: parsed.source, license, ...parsed.infobox },
      }));
      const result = await apiCall('POST', `/api/projects/${p(args.project)}/categories/${p(args.category)}/chunks/bulk`, {
        chunks: chunkData, session: s, source: 'mcp',
      });
      return { ...result, pageTitle: parsed.pageTitle, chunksCreated: chunks.length, infoboxFields: Object.keys(parsed.infobox) };
    }
    case "batch_parse_urls": {
      const results = [];
      const license = args.license || 'CC BY-NC-SA 3.0';
      for (const entry of args.urls) {
        try {
          const parsed = await parseUrl(entry.url);
          const chunks = splitTextIntoChunks(parsed.text, entry.chunk_id);
          const chunkData = chunks.map(ch => ({
            id: ch.id, text: ch.text,
            metadata: { page_title: parsed.pageTitle, source: parsed.source, license, ...parsed.infobox },
          }));
          const r = await apiCall('POST', `/api/projects/${p(args.project)}/categories/${p(args.category)}/chunks/bulk`, {
            chunks: chunkData, session: s, source: 'mcp',
          });
          results.push({ url: entry.url, chunk_id: entry.chunk_id, chunks: chunks.length, added: r.added, errors: r.errors });
        } catch (err) {
          results.push({ url: entry.url, chunk_id: entry.chunk_id, error: err.message });
        }
      }
      return { parsed: results.filter(r => !r.error).length, failed: results.filter(r => r.error).length, results };
    }
    case "bulk_update_metadata":
      return apiCall('POST', `/api/projects/${p(args.project)}/bulk-metadata`, {
        field: args.field, value: args.value, category: args.category, session: s, source: 'mcp',
      });
    case "merge_projects":
      return apiCall('POST', `/api/projects/${p(args.source)}/merge`, {
        target: args.target, session: s, source: 'mcp',
      });
    case "export_category":
      return apiCall('GET', `/api/projects/${p(args.project)}/categories/${p(args.category)}/export`);
    case "get_history":
      return apiCall('GET', `/api/projects/${p(args.project)}/history`);
    case "get_commit":
      return apiCall('GET', `/api/projects/${p(args.project)}/history/${args.commit_id}`);
    case "rollback":
      return apiCall('POST', `/api/projects/${p(args.project)}/history/${args.commit_id}/rollback`, {
        session: s, source: 'mcp',
      });
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

        case "parse_url": {
          const parsed = await parseUrl(args.url);
          const chunks = splitTextIntoChunks(parsed.text, args.chunk_id);
          const license = args.license || 'CC BY-NC-SA 3.0';
          const chunkData = chunks.map(ch => ({
            id: ch.id, text: ch.text,
            metadata: { page_title: parsed.pageTitle, source: parsed.source, license, ...parsed.infobox },
          }));
          const bulkResult = store.bulkAddChunks(args.project, args.category, chunkData);
          result = { ...bulkResult, pageTitle: parsed.pageTitle, chunksCreated: chunks.length, infoboxFields: Object.keys(parsed.infobox) };
          break;
        }

        case "batch_parse_urls": {
          const results = [];
          const license = args.license || 'CC BY-NC-SA 3.0';
          for (const entry of args.urls) {
            try {
              const parsed = await parseUrl(entry.url);
              const chunks = splitTextIntoChunks(parsed.text, entry.chunk_id);
              const chunkData = chunks.map(ch => ({
                id: ch.id, text: ch.text,
                metadata: { page_title: parsed.pageTitle, source: parsed.source, license, ...parsed.infobox },
              }));
              const r = store.bulkAddChunks(args.project, args.category, chunkData);
              results.push({ url: entry.url, chunk_id: entry.chunk_id, chunks: chunks.length, added: r.added, errors: r.errors });
            } catch (err) {
              results.push({ url: entry.url, chunk_id: entry.chunk_id, error: err.message });
            }
          }
          result = { parsed: results.filter(r => !r.error).length, failed: results.filter(r => r.error).length, results };
          break;
        }

        case "bulk_update_metadata":
          result = store.bulkUpdateMetadata(args.project, args.field, args.value, args.category);
          break;

        case "merge_projects":
          result = store.mergeProjects(args.source, args.target);
          break;

        case "export_category": {
          const exported = store.exportCategory(args.project, args.category);
          if (args.save_to_file) {
            const outPath = store._filePath(args.project).replace('.json', `.${args.category}.export.json`);
            const { writeFileSync } = await import('fs');
            writeFileSync(outPath, JSON.stringify(exported, null, 2), 'utf-8');
            result = { exported: exported.length, savedTo: outPath };
          } else {
            result = { exported: exported.length, data: exported };
          }
          break;
        }

        case "get_history":
          result = store.getHistory(args.project);
          break;

        case "get_commit":
          result = store.getCommit(args.project, args.commit_id);
          break;

        case "rollback":
          result = store.rollback(args.project, args.commit_id, 'mcp');
          break;

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
  console.error("Tryll Dataset Builder MCP server running (v1.3.0)");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
