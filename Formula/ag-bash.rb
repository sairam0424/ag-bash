class AgBash < Formula
  desc "AI-native sandboxed bash interpreter, shell, and MCP server"
  homepage "https://github.com/sairam0424/ag-bash"
  url "https://registry.npmjs.org/@ag-bash/bash/-/bash-6.0.4.tgz"
  sha256 "b95569f7cc69dfb81b76b0eeb3d6f8a7799487608492e19c700253dbf1f08e01"
  license "Apache-2.0"

  depends_on "node"

  resource "mcp-server" do
    url "https://registry.npmjs.org/@ag-bash/mcp-server/-/mcp-server-6.0.4.tgz"
    sha256 "1a72082bb7fbc2aab378276ac72dc738f0cca9b8d4129da28fc987635d963ec9"
  end

  def install
    # Install the core engine (provides the `ag-bash` and `ag-shell` bins).
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir[libexec/"bin/*"]

    # Install the standalone MCP server (provides the `ag-bash-mcp` bin) into a
    # sub-prefix so its node_modules do not collide with the core install.
    resource("mcp-server").stage do
      system "npm", "install", *std_npm_args(prefix: libexec/"mcp")
      bin.install_symlink libexec/"mcp/bin/ag-bash-mcp"
    end
  end

  test do
    assert_match "6.0.4", shell_output("#{bin}/ag-bash --version")
    system bin/"ag-shell", "--help"
    # The MCP server speaks stdio JSON-RPC; a bare invocation should start and
    # respond to --help without a connected client.
    system bin/"ag-bash-mcp", "--help"
  end
end
