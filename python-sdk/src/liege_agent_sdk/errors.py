class LiegeAPIError(RuntimeError):
    """An HTTP error returned by Liege."""

    def __init__(self, message: str, status_code: int, code: str | None = None,
                 request_id: str | None = None, retryable: bool = False):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.request_id = request_id
        self.retryable = retryable

    @property
    def status(self) -> int:
        """Compatibility alias shared with the TypeScript SDK."""
        return self.status_code
