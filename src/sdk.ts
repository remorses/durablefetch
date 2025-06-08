export const defaultDurablefetchHost = 'durablefetch.com'

function isRelativePath(url: string): boolean {
    return (
        !url.startsWith('http://') &&
        !url.startsWith('https://') &&
        !url.startsWith('//')
    )
}
const logger = console

function isLocalhost(url: URL): boolean {
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1'
}

export class DurableFetchClient {
    constructor(private options: { durablefetchHost?: string } = {}) {
        this.durablefetchHost =
            options.durablefetchHost ?? defaultDurablefetchHost
    }

    private durablefetchHost: string
    private resolveUrl(input: string | URL | Request): URL {
        let resolvedUrl: URL

        if (typeof input === 'string') {
            if (isRelativePath(input)) {
                if (typeof window === 'undefined') {
                    throw new Error(
                        'Cannot resolve relative URL in Node.js environment without base URL',
                    )
                }
                resolvedUrl = new URL(input, window.location.href)
            } else {
                resolvedUrl = new URL(input)
            }
        } else if (input instanceof URL) {
            resolvedUrl = input
        } else if (input instanceof Request) {
            resolvedUrl = new URL(input.url)
        } else {
            resolvedUrl = new URL(input)
        }

        return resolvedUrl
    }

    fetch = async (
        input: RequestInfo | URL | string,
        init?: RequestInit,
    ): Promise<Response> => {
        const url = this.resolveUrl(input)
        const realHost = url.host
        const realPathname = url.pathname
        if (isLocalhost(url)) {
            console.warn(
                `WARNING: durablefetch is bypassed for URL ${url.toString()}`,
            )
            return await fetch(url, init)
        }
        url.host = this.durablefetchHost
        url.pathname = `/${realHost}${realPathname}`

        return fetch(url, init)
    }

    async isInProgress(url: string | URL): Promise<{
        inProgress: boolean
        completed: boolean
        activeConnections: number
        chunksStored: number
    }> {
        const urlObj = this.resolveUrl(url)

        if (isLocalhost(urlObj)) {
            logger.warn(
                `WARNING: durablefetch is bypassed for URL ${url.toString()}`,
            )
            return {
                inProgress: false,
                completed: false,
                activeConnections: 0,
                chunksStored: 0,
            }
        }
        const checkUrl = new URL(
            '/in-progress',
            `https://${this.durablefetchHost}`,
        )

        const response = await fetch(checkUrl.toString(), {
            method: 'POST',
            body: JSON.stringify({
                url: urlObj.toString(),
            }),
        })

        const text = await response.text()
        try {
            return JSON.parse(text)
        } catch (e) {
            throw new Error(
                `/in-progress returned invalid JSON: ${text.slice(0, 1000)}`,
            )
        }
    }

    async delete(url: string | URL): Promise<{
        success: boolean
        message: string
    }> {
        const urlObj = this.resolveUrl(url)

        if (isLocalhost(urlObj)) {
            logger.warn(
                `WARNING: durablefetch is bypassed for URL ${url.toString()}`,
            )
            return {
                success: true,
                message: 'Fake delete for localhost',
            }
        }

        const deleteUrl = new URL('/delete', `https://${this.durablefetchHost}`)

        const response = await fetch(deleteUrl.toString(), {
            method: 'POST',
            body: JSON.stringify({
                url: urlObj.toString(),
            }),
        })

        const text = await response.text()
        try {
            return JSON.parse(text)
        } catch (e) {
            throw new Error(
                `/delete returned invalid JSON: ${text.slice(0, 1000)}`,
            )
        }
    }
}
