import { mergeToNullPrototype } from "../helpers/env.js";
import { parse } from "../parser/parser.js";
import { serialize } from "./serialize.js";
export class BashTransformPipeline {
    // biome-ignore lint/suspicious/noExplicitAny: required for type-erased plugin storage
    plugins = [];
    use(plugin) {
        this.plugins.push(plugin);
        // biome-ignore lint/suspicious/noExplicitAny: required for generic type accumulation cast
        return this;
    }
    transform(script) {
        let ast = parse(script);
        let metadata = Object.create(null);
        for (const plugin of this.plugins) {
            const result = plugin.transform({ ast, metadata });
            ast = result.ast;
            if (result.metadata) {
                metadata = mergeToNullPrototype(metadata, result.metadata);
            }
        }
        return {
            script: serialize(ast),
            ast,
            metadata: metadata,
        };
    }
}
