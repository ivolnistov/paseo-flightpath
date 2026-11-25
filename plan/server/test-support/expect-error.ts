// Assertions on DomainError codes for sync throws and async rejections.
import { expect } from "vitest";
import { DomainError, type ErrorCode } from "../../shared/errors";

export function throwsCode(fn: () => unknown, code: ErrorCode): DomainError {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, `expected DomainError(${code})`).toBeInstanceOf(DomainError);
  if (!(caught instanceof DomainError)) throw new Error(`expected DomainError(${code})`); // narrows; the assertion above already failed
  expect(caught.code).toBe(code);
  return caught;
}

export async function rejectsCode(p: Promise<unknown>, code: ErrorCode): Promise<DomainError> {
  let caught: unknown;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  expect(caught, `expected DomainError(${code})`).toBeInstanceOf(DomainError);
  if (!(caught instanceof DomainError)) throw new Error(`expected DomainError(${code})`); // narrows; the assertion above already failed
  expect(caught.code).toBe(code);
  return caught;
}
