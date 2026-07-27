// @modelcontextprotocol/sdk references this DOM alias even in Node-only projects.
type HeadersInit = [string, string][] | Record<string, string> | Headers
