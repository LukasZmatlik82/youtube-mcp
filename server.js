import express from 'express';
import cors from 'cors';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { google } from 'googleapis';

const app = express();
app.use(cors());
// CRITICAL FIX: Removed express.json() so the MCP SDK can read the raw stream directly!

// 1. Initialize the MCP Server
const mcpServer = new Server(
    { name: "youtube-uploader-mcp", version: "1.0.2" },
    { capabilities: { tools: {} } }
);

// 2. Define the Tool
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [{
            name: "upload_to_youtube",
            description: "Fetches a video from Google Drive and uploads it to YouTube.",
            inputSchema: {
                type: "object",
                properties: {
                    driveFileId: { type: "string", description: "The Google Drive file ID of the video" },
                    title: { type: "string" },
                    description: { type: "string" },
                    tags: { type: "array", items: { type: "string" } },
                    privacyStatus: { type: "string", enum: ["public", "private", "unlisted"] },
                    publishAt: { type: "string", description: "ISO 8601 formatted date (optional)" }
                },
                required: ["driveFileId", "title", "description", "privacyStatus"]
            }
        }]
    };
});

// 3. Execute the YouTube Upload logic
mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "upload_to_youtube") {
        const { driveFileId, title, description, tags, privacyStatus, publishAt } = request.params.arguments;
        
        try {
            const oauth2Client = new google.auth.OAuth2(
                process.env.GOOGLE_CLIENT_ID,
                process.env.GOOGLE_CLIENT_SECRET
            );
            oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

            const drive = google.drive({ version: 'v3', auth: oauth2Client });
            const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

            const driveResponse = await drive.files.get(
                { fileId: driveFileId, alt: 'media' },
                { responseType: 'stream' }
            );

            const insertParams = {
                part: 'snippet,status',
                requestBody: {
                    snippet: { title, description, tags },
                    status: { privacyStatus, publishAt: publishAt || undefined }
                },
                media: { body: driveResponse.data }
            };

            const res = await youtube.videos.insert(insertParams);
            
            return {
                content: [{ type: "text", text: `Success! Video uploaded to YouTube. Video ID: ${res.data.id}` }]
            };
        } catch (error) {
            return {
                content: [{ type: "text", text: `Error uploading video: ${error.message}` }],
                isError: true
            };
        }
    }
    throw new Error("Tool not found");
});

// 4. Set up the SSE web endpoints for Duvo
let transport;

app.get('/', (req, res) => {
    res.send("YouTube MCP Server is awake and running perfectly!");
});

// GET establishes the SSE stream
app.get('/mcp', async (req, res) => {
    console.log("Client connected to SSE stream.");
    // Initialize transport and tell client to POST back to /mcp
    transport = new SSEServerTransport('/mcp', res);
    await mcpServer.connect(transport);
});

// POST handles the actual commands (now with the stream fully intact)
app.post('/mcp', async (req, res) => {
    console.log("Received POST message from Duvo.");
    if (transport) {
        await transport.handlePostMessage(req, res);
    } else {
        res.status(400).send("No active MCP connection");
    }
});

// 5. Start the web server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`SSE MCP Server running on port ${PORT}`);
});
