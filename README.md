# Tryll Dataset Builder — MCP Server

An MCP (Model Context Protocol) server for building structured RAG knowledge base datasets. Use it with Claude Code to create, manage, and export JSON datasets via natural language.

Built by [Tryll Engine](https://tryllengine.com) | [Discord](https://discord.gg/CMnMrmapyB)

## Quick Start

### 1. Install

```bash
npm install -g tryll-dataset-builder-mcp
```

### 2. Add to Claude Code

Run in your terminal:

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

> "Import my existing dataset from ./data/minecraft.json"

> "Search for all chunks mentioning 'diamond' in my project"

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DATA_DIR` | `./datasets` | Directory where project JSON files are stored |

## Available Tools (18)

### Project Management
| Tool | Description |
|------|-------------|
| `create_project` | Create a new dataset project |
| `list_projects` | List all projects with stats |
| `delete_project` | Delete a project |
| `get_project_stats` | Detailed statistics |

### Category Management
| Tool | Description |
|------|-------------|
| `create_category` | Add a category to a project |
| `list_categories` | List categories with chunk counts |
| `rename_category` | Rename a category |
| `delete_category` | Delete a category and its chunks |

### Chunk Operations
| Tool | Description |
|------|-------------|
| `add_chunk` | Add a single knowledge chunk |
| `bulk_add_chunks` | Add multiple chunks at once |
| `get_chunk` | Get chunk content by ID |
| `update_chunk` | Update chunk fields |
| `delete_chunk` | Delete a chunk |
| `duplicate_chunk` | Clone a chunk |
| `move_chunk` | Move chunk between categories |

### Search & Export
| Tool | Description |
|------|-------------|
| `search_chunks` | Search by ID or text content |
| `export_project` | Export as flat JSON (RAG-ready) |
| `import_json` | Import existing JSON dataset |

## Export Format

The exported JSON is a flat array, compatible with the [Dataset Builder web app](https://github.com/Skizziik/json_creator) and ready for RAG pipelines:

```json
[
  {
    "id": "creeper",
    "text": "A Creeper is a hostile mob that silently approaches players and explodes...",
    "metadata": {
      "page_title": "Creeper",
      "source": "Minecraft Wiki",
      "license": "CC BY-NC-SA 3.0",
      "type": "hostile_mob",
      "health": "20"
    }
  }
]
```

## Example Prompts

- *"Create a Dark Souls knowledge base with categories for Bosses, Weapons, and Locations"*
- *"Add 15 chunks about Minecraft mobs with detailed descriptions"*
- *"Export my project as JSON and save to file"*
- *"Search for chunks about 'fire' in my dark_souls project"*
- *"Move chunk 'ancient_dragon' from Bosses to Enemies category"*

## License

MIT
