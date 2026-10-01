class LiegeAPIError(RuntimeError):
    """An HTTP error returned by Liege."""

    def __init__(self, message: str, status_code: int, code: str | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
