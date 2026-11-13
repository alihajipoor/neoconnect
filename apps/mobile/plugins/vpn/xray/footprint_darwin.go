package neoxifyxray

/*
#include <mach/mach.h>
#include <stdint.h>
#include <TargetConditionals.h>
#if TARGET_OS_IPHONE
#include <os/proc.h>
#endif

// The figure iOS kills a Network Extension on: phys_footprint, and the
// kernel's own high-water mark of it (ledger_phys_footprint_peak, in the
// third revision of the structure and later). -1 for what the kernel did
// not fill in.
static int64_t nx_footprint(int64_t *peak) {
	task_vm_info_data_t info;
	mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
	*peak = -1;
	if (task_info(mach_task_self(), TASK_VM_INFO, (task_info_t)&info, &count) != KERN_SUCCESS) {
		return -1;
	}
	if (count >= TASK_VM_INFO_REV3_COUNT) {
		*peak = info.ledger_phys_footprint_peak;
	}
	if (count < TASK_VM_INFO_REV1_COUNT) {
		return -1;
	}
	return (int64_t)info.phys_footprint;
}

// How much more this process may use before iOS kills it. iOS only;
// -1 on macOS, where the function does not exist.
static int64_t nx_available(void) {
#if TARGET_OS_IPHONE
	if (__builtin_available(iOS 13.0, *)) {
		return (int64_t)os_proc_available_memory();
	}
#endif
	return -1;
}
*/
import "C"

// The heartbeat names the engine that is running; WireGuard exists only in
// the darwin build (wireguard_darwin.go).
func init() { wireGuardRunningHook = WireGuardRunning }

// footprint returns the process's physical footprint and the kernel's
// peak of it, in bytes; -1 for either one the kernel would not give.
func footprint() (current, peak int64) {
	var p C.int64_t
	current = int64(C.nx_footprint(&p))
	return current, int64(p)
}

// availableMemory is iOS's own count of what is left before the
// extension is killed, or -1 where there is no such count (macOS).
func availableMemory() int64 { return int64(C.nx_available()) }
