class AgBash < Formula
  desc "AI-native sandboxed bash interpreter, shell, and MCP server"
  homepage "https://github.com/sairam0424/ag-bash"
  url "https://registry.npmjs.org/@ag-bash/bash/-/bash-6.0.2.tgz"
  sha256 "09d63e72bf779d45b1071e76e655cb30284c854b033ae86593b307ba21d2765b"
  license "Apache-2.0"

  depends_on "node"

  resource "mcp-server" do
    url "https://registry.npmjs.org/@ag-bash/mcp-server/-/mcp-server-6.0.2.tgz"
    sha256 "80541f8737253ca8bc79a51dc250619fcae20eaaeb5d2a3644c31c0c37558713"
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
    assert_match "6.0.2", shell_output("#{bin}/ag-bash --version")
    system bin/"ag-shell", "--help"
    # The MCP server speaks stdio JSON-RPC; a bare invocation should start and
    # respond to --help without a connected client.
    system bin/"ag-bash-mcp", "--help"
  end
end
