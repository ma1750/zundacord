// remove emojis, Discord Emoji escapes from string
export function getReadableString(str: string): string {
    return str
        .replace(/https?:\/\/[^\s]+/, "") // http(s) url
        .replace(/<a?:[^:]+:[0-9]+>/g, "") // discord emoji & Animated emoji
        .replace(/[^\p{L}\p{N}\p{P}\p{Z}]/gu, "") // unicode emoji
        .trim()
}
