import { browser, type Browser } from "wxt/browser";

type RuntimeMessageSender = Browser.runtime.MessageSender;
type RuntimeSendResponse<TResponse> = (response: TResponse) => void;
type RuntimeMessageHandler<TRequest, TResponse> = (
  request: TRequest,
  sender: RuntimeMessageSender,
) => TResponse | Promise<TResponse>;
type RuntimeErrorResponse = { type: "contentError"; message: string };

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function sendTabMessage<TResponse>(
  tabId: number,
  message: unknown,
): Promise<TResponse> {
  return browser.tabs.sendMessage(tabId, message) as Promise<TResponse>;
}

export function sendRuntimeMessage<TResponse>(
  message: unknown,
): Promise<TResponse> {
  return browser.runtime.sendMessage(message) as Promise<TResponse>;
}

export function addRuntimeMessageListener<TRequest, TResponse>(
  handler: RuntimeMessageHandler<TRequest, TResponse>,
): void {
  browser.runtime.onMessage.addListener(
    (
      request: TRequest,
      sender: RuntimeMessageSender,
      sendResponse: RuntimeSendResponse<TResponse | RuntimeErrorResponse>,
    ) => {
      Promise.resolve(handler(request, sender))
        .then((response) => {
          sendResponse(response);
        })
        .catch((error: unknown) => {
          sendResponse({
            type: "contentError",
            message: normalizeError(error),
          });
        });

      return true;
    },
  );
}
