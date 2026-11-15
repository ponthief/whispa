<script setup>
import TwoFactorCard from '@/components/TwoFactorCard.vue'

// The admin portal's own sign-in security (2026-11-15: "also add 2fa to the
// Admin site").
//
// THE FACTOR ALREADY APPLIED HERE. siLNt's `require_trusted_device_admin` checks
// the second factor on every admin-key route, and the portal has always had the
// /two-factor gate screen for it. What the portal lacked was anywhere to TURN IT
// ON: the switch lived on the user app's Account page, and the admin build
// compiles that page out. So an admin could not protect the most powerful
// account on the instance without first signing in to the user app.
//
// It acts on the CALLER's own account only, exactly like the Devices page
// beside it, and is the same component the Account page renders.
</script>

<template>
  <div class="page-wrap">
    <div class="page-inner">
      <div class="page-header">
        <h2 class="page-title">Two-Factor</h2>
      </div>
      <TwoFactorCard />
    </div>
  </div>
</template>
