"""geny_app — the app-side host layer around geny-executor.

Everything Geny's FastAPI backend did as a *server* lives here as a
*local* host: it builds one Pipeline per agent session, injects host
services, owns PipelineState, and speaks JSON-lines to Electron.
"""

__version__ = "0.1.0"
