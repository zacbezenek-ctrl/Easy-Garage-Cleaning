export function conversionConfig(env: NodeJS.ProcessEnv = process.env) {
  const datasetId = env.META_CAPI_DATASET_ID ?? "";
  const startAt = env.META_CAPI_START_AT ? new Date(env.META_CAPI_START_AT) : null;
  const ids = (value: string | undefined) => (value ?? "").split(",").map(x => x.trim()).filter(Boolean);
  const config = {
    mode: env.META_CAPI_MODE === "production" ? "production" as const : "shadow" as const,
    datasetId,
    verified: /^\d+$/.test(datasetId) && env.META_CAPI_DATASET_VERIFIED_ID === datasetId,
    // Keep the deployed variable name for compatibility. This attests reviewed
    // custom-stage collection and visual test receipt, not campaign optimization.
    stageCollectionVerified: env.META_CAPI_FUNNEL_VERIFIED === "true",
    accessToken: env.META_CAPI_ACCESS_TOKEN ?? "",
    testEventCode: env.META_CAPI_TEST_EVENT_CODE ?? "",
    apiVersion: /^v\d+\.0$/.test(env.META_CAPI_API_VERSION ?? "") ? env.META_CAPI_API_VERSION! : "v25.0",
    startAt: startAt && Number.isFinite(startAt.valueOf()) ? startAt : null,
    walkthroughCalendarIds: ids(env.META_CAPI_WALKTHROUGH_CALENDAR_IDS),
    jobCalendarIds: ids(env.META_CAPI_JOB_CALENDAR_IDS)
  };
  return config;
}

export type ConversionConfig = ReturnType<typeof conversionConfig>;

export function configurationHealth(config: ConversionConfig) {
  return {
    mode: config.mode, datasetId: config.datasetId || null,
    destinationVerified: config.verified, stageCollectionVerified: config.stageCollectionVerified,
    optimizationMapping: "not_verified_by_this_integration",
    tokenConfigured: Boolean(config.accessToken), testCodeConfigured: Boolean(config.testEventCode),
    startAt: config.startAt?.toISOString() ?? null,
    walkthroughCalendarCount: config.walkthroughCalendarIds.length,
    jobCalendarCount: config.jobCalendarIds.length,
    apiVersion: config.apiVersion
  };
}

export function productionBlockers(config: ConversionConfig, testAccepted: boolean): string[] {
  return [
    ...(config.mode !== "production" ? ["shadow_mode"] : []),
    ...(!config.verified ? ["destination_not_verified"] : []),
    ...(!config.accessToken ? ["access_token_missing"] : []),
    ...(!config.stageCollectionVerified ? ["crm_stage_collection_not_verified"] : []),
    ...(!config.startAt ? ["production_start_time_missing"] : []),
    ...(!config.walkthroughCalendarIds.length ? ["walkthrough_calendars_missing"] : []),
    ...(!testAccepted ? ["accepted_test_event_required"] : [])
  ];
}
