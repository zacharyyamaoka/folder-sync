package e2e

// makeBucket against a store that is still starting. WHY: the first CI run of gate G7 failed TestStorageJourneyMinIOWithTheFallbacks
// with "create bucket fs-test: 503 Service Unavailable" (MinIO answers 503 until its first start-up work is done, a moment after
// /minio/health/ready first says 200). The 503 is the store saying "ask again", so the helper asks again; any other answer is final.

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestMakeBucketAsksAgainWhileTheStoreIsStarting(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) <= 2 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	makeBucket(t, server.URL, "key", "secret", "fs-test")
	if calls.Load() != 3 {
		t.Fatalf("the bucket was asked for %d times, want 3 (two 503s, then 200)", calls.Load())
	}
}
