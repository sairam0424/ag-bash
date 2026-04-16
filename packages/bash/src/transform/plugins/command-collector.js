export class CommandCollectorPlugin {
    name = "command-collector";
    transform(context) {
        const commands = new Set();
        this.walkScript(context.ast, commands);
        return {
            ast: context.ast,
            metadata: { commands: [...commands].sort() },
        };
    }
    walkScript(node, commands) {
        for (const stmt of node.statements) {
            this.walkStatement(stmt, commands);
        }
    }
    walkStatement(node, commands) {
        for (const pipeline of node.pipelines) {
            this.walkPipeline(pipeline, commands);
        }
    }
    walkPipeline(node, commands) {
        for (const cmd of node.commands) {
            this.walkCommand(cmd, commands);
        }
    }
    walkCommand(node, commands) {
        switch (node.type) {
            case "SimpleCommand":
                if (node.name) {
                    const name = this.extractName(node.name);
                    if (name)
                        commands.add(name);
                }
                // Walk word parts for command substitutions
                if (node.name)
                    this.walkWordParts(node.name.parts, commands);
                for (const arg of node.args) {
                    this.walkWordParts(arg.parts, commands);
                }
                for (const assign of node.assignments) {
                    if (assign.value)
                        this.walkWordParts(assign.value.parts, commands);
                    if (assign.array) {
                        for (const w of assign.array) {
                            this.walkWordParts(w.parts, commands);
                        }
                    }
                }
                break;
            case "If":
                for (const clause of node.clauses) {
                    for (const s of clause.condition)
                        this.walkStatement(s, commands);
                    for (const s of clause.body)
                        this.walkStatement(s, commands);
                }
                if (node.elseBody) {
                    for (const s of node.elseBody)
                        this.walkStatement(s, commands);
                }
                break;
            case "For":
                if (node.words) {
                    for (const w of node.words) {
                        this.walkWordParts(w.parts, commands);
                    }
                }
                for (const s of node.body)
                    this.walkStatement(s, commands);
                break;
            case "CStyleFor":
                for (const s of node.body)
                    this.walkStatement(s, commands);
                break;
            case "While":
            case "Until":
                for (const s of node.condition)
                    this.walkStatement(s, commands);
                for (const s of node.body)
                    this.walkStatement(s, commands);
                break;
            case "Case":
                this.walkWordParts(node.word.parts, commands);
                for (const item of node.items) {
                    for (const s of item.body)
                        this.walkStatement(s, commands);
                }
                break;
            case "Subshell":
            case "Group":
                for (const s of node.body)
                    this.walkStatement(s, commands);
                break;
            case "ArithmeticCommand":
            case "ConditionalCommand":
                break;
            case "FunctionDef":
                this.walkCommand(node.body, commands);
                break;
        }
    }
    walkWordParts(parts, commands) {
        for (const part of parts) {
            switch (part.type) {
                case "CommandSubstitution":
                    this.walkScript(part.body, commands);
                    break;
                case "ProcessSubstitution":
                    this.walkScript(part.body, commands);
                    break;
                case "DoubleQuoted":
                    this.walkWordParts(part.parts, commands);
                    break;
                case "ParameterExpansion":
                    if (part.operation) {
                        this.walkParameterOp(part.operation, commands);
                    }
                    break;
            }
        }
    }
    walkParameterOp(op, commands) {
        switch (op.type) {
            case "DefaultValue":
            case "AssignDefault":
            case "UseAlternative":
                this.walkWordParts(op.word.parts, commands);
                break;
            case "ErrorIfUnset":
                if (op.word)
                    this.walkWordParts(op.word.parts, commands);
                break;
            case "PatternRemoval":
                this.walkWordParts(op.pattern.parts, commands);
                break;
            case "PatternReplacement":
                this.walkWordParts(op.pattern.parts, commands);
                if (op.replacement)
                    this.walkWordParts(op.replacement.parts, commands);
                break;
            case "CaseModification":
                if (op.pattern)
                    this.walkWordParts(op.pattern.parts, commands);
                break;
            case "Indirection":
                if (op.innerOp)
                    this.walkParameterOp(op.innerOp, commands);
                break;
        }
    }
    extractName(word) {
        if (word.parts.length === 1 && word.parts[0].type === "Literal") {
            return word.parts[0].value;
        }
        return null;
    }
}
