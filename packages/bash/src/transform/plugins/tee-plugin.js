import { serializeWord } from "../serialize.js";
export class TeePlugin {
    name = "tee";
    options;
    counter = 0;
    constructor(options) {
        this.options = options;
    }
    transform(context) {
        const teeFiles = [];
        const timestamp = this.options.timestamp ?? new Date();
        const ast = this.transformScript(context.ast, teeFiles, timestamp);
        return { ast, metadata: { teeFiles } };
    }
    formatTimestamp(date) {
        return date.toISOString().replace(/:/g, "-");
    }
    generateStdoutPath(index, commandName, timestamp) {
        const ts = this.formatTimestamp(timestamp);
        const idx = String(index).padStart(3, "0");
        const dir = this.options.outputDir;
        return `${dir}/${ts}-${idx}-${commandName}.stdout.txt`;
    }
    transformScript(node, teeFiles, timestamp) {
        return {
            ...node,
            statements: node.statements.map((s) => this.transformStatement(s, teeFiles, timestamp)),
        };
    }
    transformStatement(node, teeFiles, timestamp) {
        const newPipelines = [];
        const newOperators = [];
        for (let i = 0; i < node.pipelines.length; i++) {
            const pipeline = node.pipelines[i];
            // Preserve original operator connecting this pipeline
            if (i > 0) {
                newOperators.push(node.operators[i - 1]);
            }
            const result = this.transformPipeline(pipeline, teeFiles, timestamp);
            newPipelines.push(result.pipeline);
            if (result.origCmdNewIndices !== null) {
                const indices = result.origCmdNewIndices;
                // Save original PIPESTATUS entries into temp vars
                newOperators.push(";");
                newPipelines.push(this.makePipestatusSave(indices));
                // Restore PIPESTATUS and exit code with dummy pipeline.
                // Apply the original pipeline's negation here (not on the
                // wrapped pipeline) so ! inverts the restored exit code.
                newOperators.push(";");
                newPipelines.push(this.makePipestatusRestore(indices.length, result.negated));
            }
        }
        return {
            ...node,
            pipelines: newPipelines,
            operators: newOperators,
        };
    }
    transformPipeline(node, teeFiles, timestamp) {
        // Only wrap commands in existing pipelines (2+ commands).
        // Standalone commands are never wrapped — this avoids breaking
        // state-modifying builtins (read, cd, export, eval, etc.) that
        // lose their side effects when moved into a subshell pipeline.
        if (node.commands.length <= 1) {
            return { pipeline: node, origCmdNewIndices: null, negated: false };
        }
        const newCommands = [];
        const newPipeStderr = [];
        const origCmdNewIndices = [];
        let anyWrapped = false;
        for (let i = 0; i < node.commands.length; i++) {
            const cmd = node.commands[i];
            const isLast = i === node.commands.length - 1;
            // Skip non-SimpleCommand, assignment-only, and non-targeted commands
            if (cmd.type !== "SimpleCommand" ||
                !cmd.name ||
                !this.shouldTarget(cmd)) {
                origCmdNewIndices.push(newCommands.length);
                newCommands.push(cmd);
                if (!isLast) {
                    newPipeStderr.push(node.pipeStderr?.[i] ?? false);
                }
                continue;
            }
            const commandName = this.getCommandName(cmd.name) ?? "unknown";
            const idx = this.counter++;
            const stdoutFile = this.generateStdoutPath(idx, commandName, timestamp);
            const teeCmd = this.makeTeeCommand(stdoutFile);
            const command = this.serializeCommand(cmd);
            teeFiles.push({
                commandIndex: idx,
                commandName,
                command,
                stdoutFile,
            });
            origCmdNewIndices.push(newCommands.length);
            newCommands.push(cmd);
            // cmd→tee: use original outgoing pipe type (preserves |& so tee
            // captures stderr too when the original pipe was |&)
            newPipeStderr.push(node.pipeStderr?.[i] ?? false);
            newCommands.push(teeCmd);
            if (!isLast) {
                // tee→next: always regular pipe (tee produces no stderr)
                newPipeStderr.push(false);
            }
            anyWrapped = true;
        }
        if (!anyWrapped) {
            return { pipeline: node, origCmdNewIndices: null, negated: false };
        }
        return {
            pipeline: {
                ...node,
                negated: false, // strip negation; applied to restore pipeline instead
                commands: newCommands,
                pipeStderr: newPipeStderr.length > 0 ? newPipeStderr : undefined,
            },
            origCmdNewIndices,
            negated: node.negated,
        };
    }
    /**
     * Save PIPESTATUS entries for original commands into temp vars.
     * Produces: `__tps0=${PIPESTATUS[idx0]} __tps1=${PIPESTATUS[idx1]} ...`
     *
     * All expansions happen before any assignment (single simple command),
     * so all read from the same PIPESTATUS snapshot.
     */
    makePipestatusSave(origCmdNewIndices) {
        return {
            type: "Pipeline",
            commands: [
                {
                    type: "SimpleCommand",
                    assignments: origCmdNewIndices.map((newIdx, i) => ({
                        type: "Assignment",
                        name: `__tps${i}`,
                        value: {
                            type: "Word",
                            parts: [
                                {
                                    type: "ParameterExpansion",
                                    parameter: `PIPESTATUS[${newIdx}]`,
                                    operation: null,
                                },
                            ],
                        },
                        append: false,
                        array: null,
                    })),
                    name: null,
                    args: [],
                    redirections: [],
                },
            ],
            negated: false,
        };
    }
    /**
     * Restore PIPESTATUS and exit code with a dummy pipeline.
     * Produces: `(exit $__tps0) | (exit $__tps1) | ...`
     *
     * This sets PIPESTATUS to the original commands' exit codes and
     * sets $? to the last original command's exit code.
     */
    makePipestatusRestore(count, negated) {
        const commands = [];
        for (let i = 0; i < count; i++) {
            commands.push({
                type: "Subshell",
                body: [
                    {
                        type: "Statement",
                        pipelines: [
                            {
                                type: "Pipeline",
                                commands: [
                                    {
                                        type: "SimpleCommand",
                                        assignments: [],
                                        name: {
                                            type: "Word",
                                            parts: [{ type: "Literal", value: "exit" }],
                                        },
                                        args: [
                                            {
                                                type: "Word",
                                                parts: [
                                                    {
                                                        type: "ParameterExpansion",
                                                        parameter: `__tps${i}`,
                                                        operation: null,
                                                    },
                                                ],
                                            },
                                        ],
                                        redirections: [],
                                    },
                                ],
                                negated: false,
                            },
                        ],
                        operators: [],
                        background: false,
                    },
                ],
                redirections: [],
            });
        }
        return {
            type: "Pipeline",
            commands,
            negated,
        };
    }
    shouldTarget(cmd) {
        if (!this.options.targetCommandPattern) {
            return true;
        }
        const name = this.getCommandName(cmd.name);
        return name !== null && this.options.targetCommandPattern.test(name);
    }
    getCommandName(word) {
        if (!word)
            return null;
        if (word.parts.length === 1 && word.parts[0].type === "Literal") {
            return word.parts[0].value;
        }
        return null;
    }
    serializeCommand(cmd) {
        const parts = [];
        if (cmd.name) {
            parts.push(serializeWord(cmd.name));
        }
        for (const arg of cmd.args) {
            parts.push(serializeWord(arg));
        }
        return parts.join(" ");
    }
    makeTeeCommand(outputFile) {
        return {
            type: "SimpleCommand",
            assignments: [],
            name: { type: "Word", parts: [{ type: "Literal", value: "tee" }] },
            args: [
                {
                    type: "Word",
                    parts: [{ type: "Literal", value: outputFile }],
                },
            ],
            redirections: [],
        };
    }
}
