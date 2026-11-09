import type { ModelId, ModelResponse } from '@russet/ai';

export function isExpectedModelResponse(
  response: ModelResponse,
  expectedModel: ModelId,
): boolean {
  return (
    typeof response.requestId === 'string' &&
    response.requestId.trim().length > 0 &&
    typeof response.messageId === 'string' &&
    response.messageId.trim().length > 0 &&
    response.model?.providerId === expectedModel.providerId &&
    response.model?.modelId === expectedModel.modelId
  );
}
