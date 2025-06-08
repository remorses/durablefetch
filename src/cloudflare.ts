import { DurableObject } from 'cloudflare:workers'

// Helper function to create CORS headers
function getCorsHeaders(): Record<string, string> {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods':
            'GET, POST, PUT, DELETE, OPTIONS, HEAD, PATCH',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Expose-Headers': '*',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Max-Age': '86400',
    }
}

export default {
    async fetch(req: Request, env: Env) {
        const url = new URL(req.url)

        // Handle CORS preflight requests
        if (req.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: getCorsHeaders(),
            })
        }

        // Redirect root path to GitHub
        if (url.pathname === '/') {
            return Response.redirect(
                'https://github.com/remorses/durablefetch',
                307,
            )
        }

        // special case for the README demo
        if (url.searchParams.get('randomId') === 'xxxx') {
            url.searchParams.set(
                'randomId',
                Math.random().toString(36).substring(2, 18),
            )
            return new Response('', {
                status: 307,
                headers: {
                    location: url.toString(),
                    ...getCorsHeaders(),
                },
            })
        }

        if (url.pathname === '/durablefetch-example-stream-sse') {
            const n = parseInt(url.searchParams.get('n') || '10')

            const stream = new ReadableStream({
                start(controller) {
                    let count = 0
                    const interval = setInterval(() => {
                        if (count >= n) {
                            controller.enqueue(
                                new TextEncoder().encode('data: [DONE]\n\n'),
                            )
                            controller.close()
                            clearInterval(interval)
                            return
                        }

                        const data = `data: ${JSON.stringify({ number: count + 1 })}\n\n`
                        controller.enqueue(new TextEncoder().encode(data))
                        count++
                    }, 300)
                },
            })

            return new Response(stream, {
                headers: {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'x-example': 'test',
                    Connection: 'keep-alive',
                    ...getCorsHeaders(),
                },
            })
        }

        // Handle /delete POST requests
        if (url.pathname === '/delete' && req.method === 'POST') {
            const { key, requestForDO } = await createDurableObjectRequest(
                url,
                req,
            )
            const id = env.DURABLE_FETCH.idFromName(key)
            return env.DURABLE_FETCH.get(id).fetch(requestForDO)
        }

        const { key, requestForDO } = await createDurableObjectRequest(url, req)
        const id = env.DURABLE_FETCH.idFromName(key)
        return env.DURABLE_FETCH.get(id).fetch(requestForDO)
    },
}

interface Env {
    DURABLE_FETCH: DurableObjectNamespace
}

export class DurableFetch extends DurableObject {
    private seq = 0 // next chunk index
    private fetching = false // upstream started?
    private live = new Set<WritableStreamDefaultWriter>()
    // Time To Live (TTL) in milliseconds
    private timeToLiveMs = 60 * 60 * 1000 * 6

    constructor(private state: DurableObjectState) {
        super(state, {})

        // Recover position on restart
        this.state.blockConcurrencyWhile(async () => {
            this.seq = (await this.state.storage.get<number>('seq')) ?? 0
            this.fetching =
                (await this.state.storage.get<boolean>('open')) ?? false
        })
    }

    /* ------------------------------------------------------ */
    async fetch(req: Request): Promise<Response> {
        // Handle CORS preflight requests
        if (req.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: getCorsHeaders(),
            })
        }

        // Extend the TTL immediately following every fetch request
        await this.state.storage.setAlarm(Date.now() + this.timeToLiveMs)

        const url = new URL(req.url)

        // Handle /in-progress POST requests
        if (url.pathname === '/in-progress' && req.method === 'POST') {
            return this.checkInProgress()
        }

        // Handle /delete POST requests
        if (url.pathname === '/delete' && req.method === 'POST') {
            return this.deleteStorage()
        }
        // Handle case where path parts are less than 1 (empty or root path)
        const pathParts = url.pathname.split('/').filter(Boolean)
        if (pathParts.length < 1) {
            return new Response('Invalid request: missing host in path', {
                status: 400,
                headers: getCorsHeaders(),
            })
        }

        // Check if fetch was already completed by checking storage
        const isCompleted = await this.state.storage.get<boolean>('completed')

        let headers: Record<string, string> | undefined
        // Kick off upstream once (in background) - only if not already completed
        // Use blockConcurrencyWhile to prevent double bootstrap race condition
        if (!this.fetching && !isCompleted) {
            const maybeRes = await this.state.blockConcurrencyWhile(
                async () => {
                    const res = await fetch(url, {
                        method: req.method,
                        headers: req.headers,
                        body:
                            req.method === 'GET' || req.method === 'HEAD'
                                ? undefined
                                : req.body,
                    })
                    if (!res.ok) {
                        return res
                    }
                    this.fetching = true
                    headers = headersToObject(res.headers)
                    await Promise.all([
                        this.state.storage.put('open', true),
                        this.state.storage.put('headers', headers),
                    ])
                    // Move all storage operations into waitUntil for abort-safety
                    this.state.waitUntil(
                        (async () => {
                            await this.pipeUpstream(res)
                        })(),
                    )
                },
            )
            if (maybeRes) return maybeRes
        }
        if (!headers) {
            headers = await this.state.storage.get('headers')
        }
        if (!headers) {
            throw new Error(`Cannot find headers for ${url.toString()}`)
        }

        // Build a new readable stream for this client
        const { readable, writable } = new TransformStream()
        const writer = writable.getWriter()

        // 1️⃣ replay stored chunks with storage lock
        await this.state.blockConcurrencyWhile(async () => {
            const storedChunks = await this.state.storage.list<Uint8Array>({
                prefix: 'c:',
            })
            // Sort chunks by key to ensure proper ordering
            const sortedChunks = [...storedChunks].sort(([a], [b]) =>
                a.localeCompare(b),
            )
            for (const [, value] of sortedChunks) {
                writer.write(value)
            }
        })

        // 2️⃣ if upstream still open, keep streaming live
        if (this.fetching) {
            console.log(`already fetching ${req.url}, resuming stream`)
            this.live.add(writer)
        } else {
            // If completed or not started, close the writer
            writer.close()
        }

        // Fork the readable stream into two branches
        const [toClient, toDrain] = readable.tee()

        // Pipe the drain-branch to detect when client disconnects
        if (this.fetching) {
            toDrain
                .pipeTo(new WritableStream())
                .catch((e) => {
                    console.error(`readable stream error`, e)
                })
                .finally(() => this.live.delete(writer))
        }

        // Also clean up writer if it gets closed for any reason
        writer.closed.catch(() => {
            this.live.delete(writer)
        })

        return new Response(toClient, {
            headers: {
                ...headers,
                'cache-control': 'no-store',
                ...getCorsHeaders(),
            },
        })
    }

    /* ------------------------------------------------------ */
    /** Check if there's an in-progress stream */
    private async checkInProgress(): Promise<Response> {
        const inProgress = this.fetching
        const activeConnections = this.live.size
        const chunksStored = this.seq
        const completed =
            (await this.state.storage.get<boolean>('completed')) ?? false

        return new Response(
            JSON.stringify({
                inProgress,
                activeConnections,
                chunksStored,
                completed,
            }),
            {
                headers: {
                    'content-type': 'application/json',
                    ...getCorsHeaders(),
                },
            },
        )
    }

    /* ------------------------------------------------------ */
    /** Background: fetch upstream once, store + fan-out */
    private async pipeUpstream(res: Response) {
        try {
            const reader = res.body!.getReader()

            while (true) {
                const { value, done } = await reader.read()
                if (done) break

                // Persist raw bytes with zero-padded key for proper ordering
                await this.state.storage.put(
                    `c:${this.seq.toString().padStart(9, '0')}`,
                    value,
                )
                this.seq++
                await this.state.storage.put('seq', this.seq)

                // Broadcast
                for (const w of this.live) {
                    try {
                        w.write(value)
                    } catch {}
                }
            }
        } finally {
            // Mark closed and completed, close everyone
            await this.state.storage.put('open', false)
            await this.state.storage.put('completed', true)
            this.fetching = false
            // this.completed = true
            for (const w of this.live) {
                try {
                    w.close()
                } catch {}
            }
            this.live.clear()
        }
    }

    /* ------------------------------------------------------ */
    /** Delete all storage for this key */
    private async deleteStorage(): Promise<Response> {
        await this.state.storage.deleteAll()
        // Reset internal state
        this.seq = 0
        this.fetching = false
        this.live.clear()

        return new Response(
            JSON.stringify({ success: true, message: 'Storage cleared' }),
            {
                headers: {
                    'content-type': 'application/json',
                    ...getCorsHeaders(),
                },
            },
        )
    }

    /* ------------------------------------------------------ */
    /** TTL alarm handler - clean up all stored data */
    async alarm() {
        await this.state.storage.deleteAll()
    }
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

async function createDurableObjectRequest(url: URL, req: Request) {
    // For /in-progress, the upstream URL is in the body.
    if (url.pathname === '/in-progress' && req.method === 'POST') {
        const body = (await req.clone().json()) as any

        const durableObjectKey = new URL(body.url)
        const requestForDO = req
        const key = durableObjectKey.toString()
        console.log(`Using DO with key: ${key}`)

        return { requestForDO, key }
    }
    // For /delete, the upstream URL is in the body.
    else if (url.pathname === '/delete' && req.method === 'POST') {
        const body = (await req.clone().json()) as any

        const durableObjectKey = new URL(body.url)
        const requestForDO = req
        const key = durableObjectKey.toString()
        console.log(`Using DO with key: ${key}`)

        return { requestForDO, key }
    } else {
        // For other requests, extract host from path.
        const pathParts = url.pathname.split('/').filter(Boolean)
        const host = decodeURIComponent(pathParts.shift() || '')
        if (!host) {
            // This case should be handled by the root redirect but as a fallback.
            throw new Response('host not specified in path', {
                status: 400,
                headers: getCorsHeaders(),
            })
        }

        const upstreamUrl = new URL(req.url)
        upstreamUrl.host = host
        upstreamUrl.pathname = '/' + pathParts.join('/')

        const requestForDO = new Request(upstreamUrl.toString(), req)
        requestForDO.headers.set('host', upstreamUrl.host)
        const key = upstreamUrl.toString()
        console.log(`Using DO with key: ${key}`)

        return { requestForDO, key }
    }
}

export function headersToObject(headers?: HeadersInit): Record<string, string> {
    if (!headers) {
        return {}
    }

    if (headers instanceof Headers) {
        const obj: Record<string, string> = {}
        headers.forEach((value, key) => {
            obj[key] = value
        })
        return obj
    }

    if (Array.isArray(headers)) {
        const obj: Record<string, string> = {}
        for (const [key, value] of headers) {
            obj[key] = value
        }
        return obj
    }

    return headers as Record<string, string>
}
