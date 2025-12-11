// server.ts
// DEBUG VERSION: LOG EVERYTHING

const PORT = parseInt(Bun.env.PORT || "3000");
const API_KEY = Bun.env.API_KEY || "1";
const DEFAULT_MODEL = Bun.env.DEFAULT_MODEL || "publicai-gpt-4";

const UPSTREAM_HEADERS = {
  'authority': 'publicai.co',
  'accept': '*/*',
  'accept-language': 'vi-VN,vi;q=0.9',
  'content-type': 'application/json',
  'origin': 'https://publicai.co',
  'referer': 'https://publicai.co/chat',
  'sec-ch-ua': '"Chromium";v="137", "Not/A)Brand";v="24"',
  'sec-ch-ua-mobile': '?1',
  'sec-ch-ua-platform': '"Android"',
  'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36'
};

const generateId = (prefix = "") => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 20; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return prefix + result;
};

// --- Logger Helper ---
const log = (tag: string, msg: any) => console.log(`[${new Date().toISOString()}] [${tag}]`, msg);

async function* callUpstream(messages: any[], model: string) {
    const mappedMessages = messages.map((msg: any) => ({
        id: generateId(),
        role: msg.role,
        parts: [{ type: 'text', text: msg.content }]
    }));

    const upstreamPayload = {
        tools: {},
        id: generateId(),
        messages: mappedMessages,
        trigger: "submit-message"
    };

    // [DEBUG] Log payload gửi đi
    log("UPSTREAM_REQ", `Sending to PublicAI... Model: ${model}`);
    // log("UPSTREAM_PAYLOAD", JSON.stringify(upstreamPayload)); // Uncomment nếu muốn xem full body gửi đi

    const response = await fetch('https://publicai.co/api/chat', {
        method: 'POST',
        headers: UPSTREAM_HEADERS,
        body: JSON.stringify(upstreamPayload)
    });

    // [DEBUG] Log status nhận về
    log("UPSTREAM_RES", `Status: ${response.status} ${response.statusText}`);
    
    if (!response.ok) {
        const errorText = await response.text();
        log("UPSTREAM_ERR", errorText);
        throw new Error(`Upstream Error: ${response.status} - ${errorText.substring(0, 200)}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                log("STREAM", "Stream ended by server.");
                break;
            }

            const chunk = decoder.decode(value, { stream: true });
            
            // [DEBUG] Log raw chunk nhận được (cắt ngắn nếu quá dài để dễ nhìn)
            // log("RAW_CHUNK", chunk.length > 100 ? chunk.substring(0, 100) + "..." : chunk);

            buffer += chunk;
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
                if (line.trim().startsWith("data: ")) {
                    const jsonStr = line.replace("data: ", "").trim();
                    if (jsonStr === "[DONE]") {
                        log("STREAM", "Received [DONE] signal");
                        return;
                    }

                    try {
                        const data = JSON.parse(jsonStr);
                        
                        // [DEBUG] Log loại event nhận được
                        // log("SSE_EVENT", `Type: ${data.type}`);

                        if (data.type === "text-delta" && data.delta) {
                            // [DEBUG] Log content thực sự
                            // process.stdout.write(data.delta); 
                            yield data.delta;
                        } else if (data.type === "error") {
                            log("SSE_ERROR", data);
                        }
                    } catch (e) {
                        log("PARSE_ERR", `Failed to parse JSON: ${jsonStr}`);
                    }
                } else if (line.trim().length > 0) {
                     // [DEBUG] Cảnh báo nếu dòng không bắt đầu bằng "data:" (có thể là HTML lỗi)
                     log("WARN_LINE", `Unexpected line: ${line.substring(0, 50)}`);
                }
            }
        }
    } catch (err) {
        log("STREAM_ERR", err);
        throw err;
    } finally {
        reader.releaseLock();
    }
}

console.log(`🚀 Debug Proxy running on port ${PORT}`);

Bun.serve({
    port: PORT,
    async fetch(req) {
        const url = new URL(req.url);

        // Auth
        const authHeader = req.headers.get("Authorization");
        const token = authHeader?.replace("Bearer ", "");
        if (token !== API_KEY) {
            return new Response(JSON.stringify({ error: { message: "Invalid API Key" } }), { status: 401 });
        }

        if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
            try {
                const body = await req.json();
                const messages = body.messages || [];
                const stream = body.stream === true;
                const model = body.model || DEFAULT_MODEL;

                log("CLIENT_REQ", `Stream: ${stream}, Messages: ${messages.length}`);

                const generator = callUpstream(messages, model);
                const created = Math.floor(Date.now() / 1000);
                const id = generateId("chatcmpl-");

                if (stream) {
                    const encoder = new TextEncoder();
                    const streamResponse = new ReadableStream({
                        async start(controller) {
                            try {
                                for await (const chunk of generator) {
                                    const ssePayload = {
                                        id, object: "chat.completion.chunk", created, model,
                                        choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }]
                                    };
                                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(ssePayload)}\n\n`));
                                }
                                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                            } catch (e) {
                                log("STREAM_FAIL", e);
                                const errPayload = { error: { message: "Upstream stream failed" } };
                                controller.enqueue(encoder.encode(`data: ${JSON.stringify(errPayload)}\n\n`));
                            } finally {
                                controller.close();
                            }
                        }
                    });

                    return new Response(streamResponse, {
                        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" }
                    });
                } else {
                    let fullContent = "";
                    try {
                        for await (const chunk of generator) {
                            fullContent += chunk;
                        }
                        
                        log("NON_STREAM", `Completed. Length: ${fullContent.length}`);

                        if (!fullContent) {
                            log("WARN", "Full content is empty!");
                        }

                        return new Response(JSON.stringify({
                            id, object: "chat.completion", created, model,
                            choices: [{ index: 0, message: { role: "assistant", content: fullContent }, finish_reason: "stop" }],
                            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
                        }), { headers: { "Content-Type": "application/json" } });

                    } catch (e: any) {
                        return new Response(JSON.stringify({ error: { message: e.message } }), { status: 500, headers: { "Content-Type": "application/json" } });
                    }
                }

            } catch (error: any) {
                log("SERVER_ERR", error);
                return new Response(JSON.stringify({ error: { message: error.message } }), { status: 500 });
            }
        }
        
        // Models endpoint (giữ nguyên)
        if (req.method === "GET" && url.pathname === "/v1/models") {
             return new Response(JSON.stringify({ object: "list", data: [{ id: DEFAULT_MODEL, object: "model", created: Date.now(), owned_by: "publicai" }] }), { headers: { "Content-Type": "application/json" } });
        }

        return new Response("Not Found", { status: 404 });
    }
});
