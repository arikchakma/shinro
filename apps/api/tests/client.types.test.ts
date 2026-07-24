import type { Client, InferRequestType, InferResponseType } from "../.daroyan/client.ts";
import { expectTypeOf, test } from "vite-plus/test";

type CreateResource = Client["v1"]["resources"]["$post"];
type GetResource = Client["v1"]["resources"][":id"]["$get"];
type GetMember = Client["v1"]["teams"][":teamId"]["members"][":memberId"]["$get"];
type GetProtected = Client["v1"]["protected"]["$get"];
type ProtectedResponse = Awaited<ReturnType<GetProtected>>;

test("the generated client exposes validated request inputs", () => {
  expectTypeOf<InferRequestType<CreateResource>["json"]>().toEqualTypeOf<{
    name: string;
  }>();
  expectTypeOf<InferRequestType<GetResource>["param"]>().toEqualTypeOf<{
    id: string;
  }>();
});

test("filename parameters and middleware responses reach the generated client", () => {
  expectTypeOf<InferRequestType<GetMember>["param"]>().toMatchTypeOf<{
    memberId: string;
    teamId: string;
  }>();
  expectTypeOf<ProtectedResponse["status"]>().toEqualTypeOf<200 | 401>();
  expectTypeOf<InferResponseType<GetProtected>>().toEqualTypeOf<
    { error: "UNAUTHORIZED" } | { requestId: string; secret: "daroyan" }
  >();
});

test("manual and default sub-router paths are retained by RPC generation", () => {
  expectTypeOf<Client["v1"]["manual"]["$get"]>().toBeFunction();
  expectTypeOf<Client["v1"]["admin"]["stats"]["$get"]>().toBeFunction();
});
