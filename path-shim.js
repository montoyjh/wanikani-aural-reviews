// Custom path shim that preserves URL protocols
import pathBrowserify from 'path-browserify';

// Wrap path.join to handle URLs with protocols
const originalJoin = pathBrowserify.join;

pathBrowserify.join = function(...args) {
    // Check if first arg is a URL with protocol
    if (args.length > 0 && typeof args[0] === 'string') {
        const match = args[0].match(/^(https?:\/\/[^\/]+)(\/.*)?$/);
        if (match) {
            const origin = match[1];
            const basePath = match[2] || '';
            // Join the path parts without the origin, then prepend origin
            const pathParts = [basePath, ...args.slice(1)];
            const joinedPath = originalJoin.apply(this, pathParts);
            return origin + joinedPath;
        }
    }
    return originalJoin.apply(this, args);
};

export default pathBrowserify;
export const { join, resolve, dirname, basename, extname, normalize, sep } = pathBrowserify;
