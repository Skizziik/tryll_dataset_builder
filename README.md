# Tryll Dataset Builder — MCP Server

An MCP (Model Context Protocol) server for building structured RAG knowledge base datasets. Use it with Claude Code to create, manage, and export JSON datasets via natural language — with optional real-time sync to the [Dataset Builder web app](https://trylljsoncreator.onrender.com).

Built by [Tryll Engine](https://tryllengine.com) | [Discord](https://discord.gg/CMnMrmapyB)

---

## Quick Start

### 1. Install

```bash
npm install -g tryll-dataset-builder-mcp
```

### 2. Add to Claude Code

```bash
claude mcp add dataset-builder -- npx tryll-dataset-builder-mcp
```

Or manually add to `~/.claude/mcp_settings.json`:

```json
{
  "mcpServers": {
    "dataset-builder": {
      "command": "npx",
      "args": ["tryll-dataset-builder-mcp"],
      "env": {
        "DATA_DIR": "./datasets"
      }
    }
  }
}
```

### 3. Use

Just talk to Claude:

> "Create a knowledge base about Minecraft with categories: Mobs, Blocks, Biomes. Add 10 chunks to each category."

> "Parse this wiki page and add it to my dataset: https://minecraft.wiki/w/Creeper"

> "Show me the version history of my project"

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DATA_DIR` | `./datasets` | Directory for project JSON files (local mode) |

---

## Two Modes of Operation

### Local Mode (default)
Data is stored as JSON files in `DATA_DIR`. No server needed.

### Connected Mode (real-time sync)
Connect to the [Dataset Builder web app](https://trylljsoncreator.onrender.com) for live collaboration. Changes made via MCP appear instantly in the browser, and vice versa.

```
You: "Connect to session ABC123"
Claude: *connects via WebSocket*
You: "Add 5 chunks about dragons"
→ chunks appear in the browser in real-time
```

---

## Available Tools (27)

### Session Management

| Tool | Description |
|------|-------------|
| `connect_session` | Connect to the web app for real-time collaboration. Requires a 6-character session code from the browser UI |
| `disconnect_session` | Disconnect from the web app, switch back to local storage |

### Project Management

| Tool | Description |
|------|-------------|
| `create_project` | Create a new dataset project |
| `list_projects` | List all projects with stats |
| `delete_project` | Permanently delete a project |
| `get_project_stats` | Detailed statistics (categories, chunks, text lengths) |

### Category Management

| Tool | Description |
|------|-------------|
| `create_category` | Add a category to organize chunks |
| `list_categories` | List categories with chunk counts |
| `rename_category` | Rename a category |
| `delete_category` | Delete a category and all its chunks |

### Chunk Operations

| Tool | Description |
|------|-------------|
| `add_chunk` | Add a single knowledge chunk with ID, text, and metadata |
| `bulk_add_chunks` | Add multiple chunks at once (faster than one by one) |
| `get_chunk` | Get full content of a chunk by ID |
| `update_chunk` | Update chunk fields (ID, text, metadata) |
| `delete_chunk` | Delete a chunk by ID |
| `duplicate_chunk` | Clone a chunk (creates `id_copy`) |
| `move_chunk` | Move a chunk between categories |

### Search & Export

| Tool | Description |
|------|-------------|
| `search_chunks` | Search by chunk ID or text content |
| `export_project` | Export as flat JSON array (RAG-ready) |
| `import_json` | Import an existing JSON dataset |
| `export_category` | Export a single category as JSON |

### URL Parsing

| Tool | Description |
|------|-------------|
| `parse_url` | Fetch a web page, extract text, auto-create chunks. Splits text > 2000 chars into multiple chunks. Extracts wiki infobox metadata |
| `batch_parse_urls` | Parse multiple URLs at once |

### Bulk Operations

| Tool | Description |
|------|-------------|
| `bulk_update_metadata` | Set a metadata field across all chunks (or per category) |
| `merge_projects` | Merge all data from one project into another |

### Version History

| Tool | Description |
|------|-------------|
| `get_history` | Get version history (last 50 commits) for a project |
| `get_commit` | Get a specific commit with full snapshot data for diffing |
| `rollback` | Rollback a project to a previous commit's state |

---

## Tool Details

### `add_chunk`

```
project: "minecraft"
category: "Mobs"
id: "creeper"
text: "A Creeper is a hostile mob that silently approaches players..."
metadata:
  page_title: "Creeper"
  source: "Minecraft Wiki"
  license: "CC BY-NC-SA 3.0"
  health: "20"          ← custom metadata field
  behavior: "explodes"  ← custom metadata field
```

Standard metadata fields: `page_title`, `source`, `license`. Any extra fields become custom metadata.

### `parse_url`

```
project: "minecraft"
category: "Mobs"
url: "https://minecraft.wiki/w/Creeper"
chunk_id: "creeper"
license: "CC BY-NC-SA 3.0"
```

- Fetches the page, extracts main text content
- If text > 2000 chars → auto-splits into `creeper_1`, `creeper_2`, etc.
- Extracts page title and source URL as metadata
- For wiki pages: extracts infobox/sidebar data as custom metadata fields

### `get_history`

```
project: "minecraft"
```

Returns:
```json
[
  {
    "id": "uuid",
    "timestamp": "2026-02-27T14:30:00.000Z",
    "source": "mcp",
    "action": "addChunk",
    "summary": "Added chunk 'creeper' to 'Mobs'",
    "stats": { "categories": 3, "chunks": 12 }
  }
]
```

### `rollback`

```
project: "minecraft"
commit_id: "uuid-of-target-commit"
```

Restores the project to that commit's snapshot. Creates a new "rollback" commit so you can undo the rollback later.

---

## Data Formats

### Project JSON (internal)

```json
{
  "name": "minecraft",
  "createdAt": "2026-02-27T10:00:00.000Z",
  "categories": [
    {
      "id": "uuid",
      "name": "Mobs",
      "expanded": true,
      "chunks": [
        {
          "_uid": "uuid",
          "id": "creeper",
          "text": "A Creeper is a hostile mob...",
          "metadata": {
            "page_title": "Creeper",
            "source": "Minecraft Wiki",
            "license": "CC BY-NC-SA 3.0"
          },
          "customFields": [
            { "key": "health", "value": "20" }
          ]
        }
      ]
    }
  ]
}
```

### Export Format (RAG-ready)

```json
[
  {
    "id": "creeper",
    "text": "A Creeper is a hostile mob that silently approaches players and explodes...",
    "metadata": {
      "page_title": "Creeper",
      "source": "Minecraft Wiki",
      "license": "CC BY-NC-SA 3.0",
      "health": "20"
    }
  }
]
```

### History Commit

```json
{
  "id": "uuid",
  "timestamp": "2026-02-27T14:30:00.000Z",
  "source": "browser | mcp",
  "action": "addChunk",
  "summary": "Added chunk 'creeper' to 'Mobs'",
  "stats": { "categories": 3, "chunks": 12 },
  "snapshot": { "...full project state..." }
}
```

---

## Real-Time Collaboration

```
┌─────────────┐     WebSocket      ┌──────────────┐     REST API     ┌─────────────┐
│   Browser    │ ◄──────────────► │  Web Server   │ ◄──────────────► │  MCP Server  │
│  (Dataset    │   data:changed    │  (Express +   │   POST/PUT/DEL   │  (Claude     │
│   Builder)   │   mcp:connected   │   WebSocket)  │   + source:mcp   │   Code)      │
└─────────────┘                    └──────────────┘                    └─────────────┘
```

1. Open the [Dataset Builder](https://trylljsoncreator.onrender.com) in your browser
2. Copy the 6-character session code from the top bar
3. Tell Claude: *"Connect to session ABC123"*
4. All changes sync in real-time between browser and Claude
5. Version history tracks who made each change (browser vs MCP)

---

## Example Prompts

- *"Create a Dark Souls knowledge base with categories for Bosses, Weapons, and Locations"*
- *"Parse these wiki pages and add them to my Minecraft project: [url1], [url2], [url3]"*
- *"Bulk update the license field to 'MIT' for all chunks in the Mobs category"*
- *"Show me the version history of my project"*
- *"Rollback my project to the commit before I deleted that category"*
- *"Merge my test_data project into the main production project"*
- *"Export the Bosses category as JSON"*
- *"Connect to session XYZ789 and add 20 chunks about potions"*

---

## Links

- **Web App**: [trylljsoncreator.onrender.com](https://trylljsoncreator.onrender.com)
- **Web App Repo**: [github.com/Skizziik/json_creator](https://github.com/Skizziik/json_creator)
- **MCP Repo**: [github.com/Skizziik/tryll_dataset_builder](https://github.com/Skizziik/tryll_dataset_builder)
- **npm**: [tryll-dataset-builder-mcp](https://www.npmjs.com/package/tryll-dataset-builder-mcp)
- **Tryll Engine**: [tryllengine.com](https://tryllengine.com)
- **Discord**: [discord.gg/CMnMrmapyB](https://discord.gg/CMnMrmapyB)

## License

MIT
