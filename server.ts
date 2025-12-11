// server.ts
const PORT = parseInt(Bun.env.PORT || "3000");
const API_KEY = Bun.env.API_KEY || "1";
const DEFAULT_MODEL = Bun.env.DEFAULT_MODEL || "publicai-gpt-4";

// --- Headers giả lập (Giữ nguyên từ request cũ) ---
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

// --- Utils ---
const generateId = (prefix = "") => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 20; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return prefix + result;
};

// --- Core Logic: Upstream Caller ---
// Hàm này trả về một Async Generator để dễ dàng xử lý cho cả Stream và Non-stream
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

    const response = await fetch('https://publicai.co/api/chat', {
        method: 'POST',
        headers: UPSTREAM_HEADERS,
        body: JSON.stringify(upstreamPayload)
    });

    if (!response.ok) throw new Error(`Upstream Error: ${response.statusText}`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
                if (line.trim().startsWith("data: ")) {
                    const jsonStr = line.replace("data: ", "").trim();
                    if (jsonStr === "[DONE]") return; // End of stream

                    try {
                        const data = JSON.parse(jsonStr);
                        if (data.type === "text-delta" && data.delta) {
                            yield data.delta; // Chỉ yield phần text thay đổi
                        }
                    } catch (e) { /* Ignore parse error */ }
                }
            }
        }
    } finally {
        reader.releaseLock();
    }
}

// --- Server Definition ---
console.log(`🚀 Proxy running on port ${PORT} with model ${DEFAULT_MODEL}`);

Bun.serve({
    port: PORT,
    async fetch(req) {
        const url = new URL(req.url);

        // 1. Auth Middleware
        const authHeader = req.headers.get("Authorization");
        const token = authHeader?.replace("Bearer ", "");
        if (token !== API_KEY) {
            return new Response(JSON.stringify({ error: { message: "Invalid API Key", type: "invalid_request_error" } }), { status: 401 });
        }

        // 2. Endpoint: /v1/models
        if (req.method === "GET" && url.pathname === "/v1/models") {
            return new Response(JSON.stringify({
                object: "list",
                data: [{
                    id: DEFAULT_MODEL,
                    object: "model",
                    created: Math.floor(Date.now() / 1000),
                    owned_by: "publicai"
                }]
            }), { headers: { "Content-Type": "application/json" } });
        }

        // 3. Endpoint: /v1/chat/completions
        if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
            try {
                const body = await req.json();
                const messages = body.messages || [];
                const stream = body.stream === true;
                const model = body.model || DEFAULT_MODEL;

                const generator = callUpstream(messages, model);
                const created = Math.floor(Date.now() / 1000);
                const id = generateId("chatcmpl-");

                // --- Case A: Streaming Response ---
                if (stream) {
                    const encoder = new TextEncoder();
                    const streamResponse = new ReadableStream({
                        async start(controller) {
                            for await (const chunk of generator) {
                                const ssePayload = {
                                    id, object: "chat.completion.chunk", created, model,
                                    choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }]
                                };
                                controller.enqueue(encoder.encode(`data: ${JSON.stringify(ssePayload)}\n\n`));
                            }
                            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                            controller.close();
                        }
                    });

                    return new Response(streamResponse, {
                        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" }
                    });
                }

                // --- Case B: Non-Streaming Response (Buffer all) ---
                else {
                    let fullContent = "";
                    for await (const chunk of generator) {
                        fullContent += chunk;
                    }

                    return new Response(JSON.stringify({
                        id, object: "chat.completion", created, model,
                        choices: [{ index: 0, message: { role: "assistant", content: fullContent }, finish_reason: "stop" }],
                        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } // Fake usage
                    }), { headers: { "Content-Type": "application/json" } });
                }

            } catch (error: any) {
                console.error("Handler Error:", error);
                return new Response(JSON.stringify({ error: { message: error.message || "Internal Error" } }), { status: 500 });
            }
        }

        return new Response("Not Found", { status: 404 });
    }
});
