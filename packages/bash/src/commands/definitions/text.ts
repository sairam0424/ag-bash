import type { LazyCommandDef } from "../lib.js";
import type { CommandName } from "../registry.js";

export const textLoaders: LazyCommandDef<CommandName>[] = [
  // Text processing
  {
    name: "grep" as CommandName,
    load: async () => (await import("../grep/grep.js")).grepCommand,
  },
  {
    name: "fgrep" as CommandName,
    load: async () => (await import("../grep/grep.js")).fgrepCommand,
  },
  {
    name: "egrep" as CommandName,
    load: async () => (await import("../grep/grep.js")).egrepCommand,
  },
  {
    name: "rg" as CommandName,
    load: async () => (await import("../rg/rg.js")).rgCommand,
  },
  {
    name: "sed" as CommandName,
    load: async () => (await import("../sed/sed.js")).sedCommand,
  },
  {
    name: "awk" as CommandName,
    load: async () => (await import("../awk/awk2.js")).awkCommand2,
  },
  {
    name: "sort" as CommandName,
    load: async () => (await import("../sort/sort.js")).sortCommand,
  },
  {
    name: "uniq" as CommandName,
    load: async () => (await import("../uniq/uniq.js")).uniqCommand,
  },
  {
    name: "comm" as CommandName,
    load: async () => (await import("../comm/comm.js")).commCommand,
  },
  {
    name: "cut" as CommandName,
    load: async () => (await import("../cut/cut.js")).cutCommand,
  },
  {
    name: "paste" as CommandName,
    load: async () => (await import("../paste/paste.js")).pasteCommand,
  },
  {
    name: "tr" as CommandName,
    load: async () => (await import("../tr/tr.js")).trCommand,
  },
  {
    name: "rev" as CommandName,
    load: async () => (await import("../rev/rev.js")).rev,
  },
  {
    name: "nl" as CommandName,
    load: async () => (await import("../nl/nl.js")).nl,
  },
  {
    name: "fold" as CommandName,
    load: async () => (await import("../fold/fold.js")).fold,
  },
  {
    name: "expand" as CommandName,
    load: async () => (await import("../expand/expand.js")).expand,
  },
  {
    name: "unexpand" as CommandName,
    load: async () => (await import("../expand/unexpand.js")).unexpand,
  },
  {
    name: "strings" as CommandName,
    load: async () => (await import("../strings/strings.js")).strings,
  },
  {
    name: "split" as CommandName,
    load: async () => (await import("../split/split.js")).split,
  },
  {
    name: "column" as CommandName,
    load: async () => (await import("../column/column.js")).column,
  },
  {
    name: "join" as CommandName,
    load: async () => (await import("../join/join.js")).join,
  },
  {
    name: "tee" as CommandName,
    load: async () => (await import("../tee/tee.js")).teeCommand,
  },
  {
    name: "tac" as CommandName,
    load: async () => (await import("../tac/tac.js")).tac,
  },
  {
    name: "od" as CommandName,
    load: async () => (await import("../od/od.js")).od,
  },

  // Data processing
  {
    name: "jq" as CommandName,
    load: async () => (await import("../jq/jq.js")).jqCommand,
  },
  {
    name: "base64" as CommandName,
    load: async () => (await import("../base64/base64.js")).base64Command,
  },
  {
    name: "diff" as CommandName,
    load: async () => (await import("../diff/diff.js")).diffCommand,
  },
  {
    name: "date" as CommandName,
    load: async () => (await import("../date/date.js")).dateCommand,
  },
  {
    name: "sleep" as CommandName,
    load: async () => (await import("../sleep/sleep.js")).sleepCommand,
  },
  {
    name: "timeout" as CommandName,
    load: async () => (await import("../timeout/timeout.js")).timeoutCommand,
  },
  {
    name: "time" as CommandName,
    load: async () => (await import("../time/time.js")).timeCommand,
  },
  {
    name: "seq" as CommandName,
    load: async () => (await import("../seq/seq.js")).seqCommand,
  },
  {
    name: "expr" as CommandName,
    load: async () => (await import("../expr/expr.js")).exprCommand,
  },

  // Checksums
  {
    name: "md5sum" as CommandName,
    load: async () => (await import("../md5sum/md5sum.js")).md5sumCommand,
  },
  {
    name: "sha1sum" as CommandName,
    load: async () => (await import("../md5sum/sha1sum.js")).sha1sumCommand,
  },
  {
    name: "sha256sum" as CommandName,
    load: async () => (await import("../md5sum/sha256sum.js")).sha256sumCommand,
  },

  // Compression
  {
    name: "gzip" as CommandName,
    load: async () => (await import("../gzip/gzip.js")).gzipCommand,
  },
  {
    name: "gunzip" as CommandName,
    load: async () => (await import("../gzip/gzip.js")).gunzipCommand,
  },
  {
    name: "zcat" as CommandName,
    load: async () => (await import("../gzip/gzip.js")).zcatCommand,
  },

  // Misc
  {
    name: "file" as CommandName,
    load: async () => (await import("../file/file.js")).fileCommand,
  },
  {
    name: "html-to-markdown" as CommandName,
    load: async () =>
      (await import("../html-to-markdown/html-to-markdown.js"))
        .htmlToMarkdownCommand,
  },
];
