import { browser, type Browser } from "wxt/browser";

type RuntimeMessageSender = Browser.runtime.MessageSender;
type RuntimeSendResponse<TResponse> = (response: TResponse) => void;
type RuntimeMessageHandler<TRequest, TResponse> = (
  request: TRequest,
  sender: RuntimeMessageSender,
) => TResponse | Promise<TResponse>;
type RuntimeMessageListenerOptions<TResponse> = {
  createErrorResponse: (error: unknown) => TResponse;
};

export function sendTabMessage<TRequest, TResponse>(
  tabId: number,
  message: TRequest,
): Promise<TResponse> {
  return browser.tabs.sendMessage(tabId, message) as Promise<TResponse>;
}

export function sendRuntimeMessage<TRequest, TResponse>(
  message: TRequest,
): Promise<TResponse> {
  return browser.runtime.sendMessage(message) as Promise<TResponse>;
}

export function addRuntimeMessageListener<TRequest, TResponse>(
  handler: RuntimeMessageHandler<TRequest, TResponse>,
  options: RuntimeMessageListenerOptions<TResponse>,
): void {
  browser.runtime.onMessage.addListener(
    (
      request: TRequest,
      sender: RuntimeMessageSender,
      sendResponse: RuntimeSendResponse<TResponse>,
    ) => {
      Promise.resolve(handler(request, sender))
        .then((response) => {
          sendResponse(response);
        })
        .catch((error: unknown) => {
          sendResponse(options.createErrorResponse(error));
        });

      return true;
    },
  );
}
