# durablefetch

**Durable, resumable `fetch()` for browsers and Node.js – powered by Cloudflare Durable Objects.**
Send a long-running request (e.g. OpenAI streaming), close the tab, come back later, and pick up the stream exactly where you left off.

- `npm i durablefetch`
- **Zero-config** CDN endpoint: `https://durablefetch.com`
- **Self-host** in minutes (Cloudflare Workers)

---

## Example

To see how durablefetch works you can try visiting this url in the browser in different tabs: https://durablefetch.com/postman-echo.com/server-events/20?randomId=xxxx

> [!IMPORTANT]
> durablefetch identifies requests by the URL, each different request should have an unique URL. For example for a ChatGPT like interface you would use the chat id or message id.

## Why?

Typical HTTP streams die when the client disconnects.
`durablefetch` puts a Cloudflare Durable Object between you and the origin:

1. **First request** → DO starts the upstream fetch in `waitUntil()`.
2. Every chunk is **persisted** (`state.storage`) and fanned-out to all live clients.
3. If the browser drops, the DO keeps going.
4. **Later requests with the same URL** → stored chunks replayed, live stream continues.
5. Once the origin finishes, the DO marks the conversation complete; subsequent callers just get the full buffered response.

Persistence lasts for a few hours (6 hours by default).

---

## Quick start with AI SDK

Simply replace the default fetch with durablefetch to make sure the AI response is resumed if an existing one is alreay in progress.

```tsx
import { DefaultChatTransport } from 'ai'
import { DurableFetchClient } from 'durablefetch'

const df = new DurableFetchClient()

export function Chat({ chatId }) {
    const api = `/api/chat?chatId=${chatId}`

    useEffect(() => {
        // if in progress, send message and resume stream with durablefetch
        df.isInProgress(api).then(({ inProgress }) => {
            if (inProgress) {
                const text = localStorage.getItem('lastMessage') || ''
                return sendMessage({
                    text,
                })
            }
        })
    }, [])

    const { messages, sendMessage, error } = useChat({
        transport: new DefaultChatTransport({ api, fetch: df.fetch }),
        id: chatId,
    })

    return (
        <div className='flex flex-col w-full h-dvh py-8 stretch'>
            <div className='space-y-4 flex-grow overflow-y-auto'>
                {messages.map((m) => {
                    if (!m.parts?.length) return
                    return (
                        <div key={m.id} className='max-w-xl mx-auto'>
                            <div className='font-bold'>{m.role}</div>
                            <div className='space-y-4'>
                                {m.parts.map((p, i) => {
                                    switch (p.type) {
                                        case 'text':
                                            return (
                                                <div key={i}>
                                                    <p>{p.text}</p>
                                                </div>
                                            )
                                    }
                                })}
                            </div>
                        </div>
                    )
                })}
            </div>

            <form
                onSubmit={(e) => {
                    e.preventDefault()
                    const message = new FormData(e.currentTarget).get('message')
                    sendMessage({ text: message })
                    localStorage.setItem('lastMessage', message)
                    e.currentTarget.reset()
                }}
                className='w-full max-w-xl mx-auto'
            >
                <input
                    autoFocus
                    className='w-full p-2 border border-gray-300 rounded shadow-xl'
                    name='message'
                    placeholder='Say something...'
                />
            </form>
        </div>
    )
}
```

## Quick start (client SDK)

```ts
import { DurableFetchClient } from 'durablefetch'

const df = new DurableFetchClient() // defaults to durablefetch.com

// 1. Start a streaming request
const res = await df.fetch(
    'https://api.openai.com/v1/chat/completions?chatId=xxx',
    {
        method: 'POST',
        body: JSON.stringify({
            /* … */
        }),
    },
)

// 2. Other fetch requests to the same url resumes the existing request or return the already completed response

// 3. Ask whether the stream is still in progress (optional)
const status = await df.isInProgress(
    'https://api.openai.com/v1/chat/completions?chatId=xxx',
)
console.log(status) // { inProgress: true, activeConnections: 1, chunksStored: 42, completed: false }

// 4. Delete a stored response (optional)
const deleteResult = await df.delete(
    'https://api.openai.com/v1/chat/completions?chatId=xxx',
)
console.log(deleteResult) // { success: true, message: "Response deleted successfully" }
```

## Usage with the API (no SDK)

durablefetch works by passing the host as the first part of the path, then the path of the url:

```
https://durablefetch.com/:domain/*
```

So for example this request makes a fetch to `https://postman-echo.com/server-events/20?randomId=xxxx`

```
https://durablefetch.com/postman-echo.com/server-events/20?randomId=xxxx
```

Always remember to make your URLs unique and non guessable

## Security

Always add a non guessable unique search parameter to the url so urls cannot be guessed and be used to read the response by non authrorized users.

The response in durablefetch is deleted from the last use after 6 hours.

If you are going to attach secret data to headers like authroization tokens you should self host in your own Cloudflare account.

## Demo

Here is a demo AI app that uses durablefetch: https://github.com/remorses/durablefetch-ai-demo
