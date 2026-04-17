class AgBash < Formula
  desc "Secure unified agentic bash runtime and MCP server"
  homepage "https://github.com/sairam0424/ag-bash"
  url "https://registry.npmjs.org/@ag-bash/bash/-/bash-1.2.0.tgz"
  sha256 "ab688d49b033363809c938bef91de2dad68c161aa072b527c5fef2643cd14297"
  license "MIT"

  depends_on "node"

  resource "mcp-server" do
    url "https://registry.npmjs.org/@ag-bash/mcp-server/-/mcp-server-1.2.0.tgz"
    sha256 "eaf3ee05b79d0fab50d6d935b596fd46dd4db7319eaaf358c3e70420c7d97f56"
  end

  def install
    # Install core bash package
    system "npm", "install", *Language::Node.std_npm_install_args(libexec)
    
    # Symlink core binaries
    bin.install_symlink Dir["#{libexec}/bin/*"]

    # Install MCP server as a resource
    resource("mcp-server").stage do
      system "npm", "install", *Language::Node.std_npm_install_args(libexec/"mcp")
      # Manually symlink the MCP binary since it's in a subdirectory
      bin.install_symlink libexec/"mcp/bin/ag-mcp-server"
    end
  end

  test do
    system "#{bin}/ag-bash", "--version"
    system "#{bin}/ag-shell", "--help"
    system "#{bin}/ag-mcp-server", "--help"
  end
end
