/**
 * AMD files specified here are targeted specifically for requireJS bundling. During prod builds, the optimizer looks
 * at all of these files' dependencies and bundles everything into them, overwriting the original file. This
 * substantially cuts down on requests.
 */
var _componentsToBundle = [
	"page1",
	"page2"
];