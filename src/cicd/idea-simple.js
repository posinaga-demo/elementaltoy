// tekton SDK
import { tekton } from "https://storage.googleapis.com/tekton-releases/js-sdk/latest/tekton-sdk.ts"

// task catalog dependencies
import { kaniko } from "https://storage.googleapis.com/tekton-releases/js-sdk/latest/taskcatalog/kaniko.ts"
import { gcloud } from "https://storage.googleapis.com/tekton-releases/js-sdk/latest/taskcatalog/gcloud.ts"

// trigger catalog dependencies
import { githubpushtrigger } from "https://storage.googleapis.com/tekton-releases/js-sdk/latest/triggerscatalog/githubpushtrigger.ts"

tekton.init({
    githubCredentials: tekton.getSecret("github-credentials"),
    containerRegistryCredentials: tekton.getSecret("container-registry-credentials"),
    gcpCredentials: tekton.getSecret("gcp-credentials")
});

tekton.trigger(githubpushtrigger, {repo: "https://github.com/posinaga-demo/elementaltoy"}, (ctx, githubRequest) => {
    ctx.runPipeline("ephemeral-environment", githubRequest.gitRepo, githubRequest.commit_sha);
});

tekton.pipeline("ephemeral-environment", (ctx, gitRepo, commit_sha) => {
    const image_prefix = "gcr.io/elementaltest/";
    const frontend_name = "elementaltoy-frontend-ephemeral" + commit_sha;
    const loadtest_name = "elementaltoy-loadtest-ephemeral" + commit_sha;
    const frontend_image = image_prefix + frontend_name;
    const loadtest_image = image_prefix + loadtest_name;
    ctx.runTask({task: kaniko, name: "build-frontend", gitRepo: gitRepo, buildDir: "./src/frontend", image: frontend_image});
    ctx.runTask({task: kaniko, name: "build--loadtest", gitRepo: gitRepo, buildDir: "./src/loadtest", image: loadtest_image});
    ctx.runTask({after: "build-frontend", task: "deploy-to-cloud-run", name: "deploy-frontend", image: frontend_image, serviceName: frontend_name});
    ctx.runTask({after: "build-loadtest", task: "deploy-to-cloud-run", name: "deploy-loadtest", image: loadtest_image, serviceName: loadtest_name});
    ctx.waitForTrigger({})
});

tekton.task("deploy-to-cloud-run", (ctx, image, serviceName) => {
    ctx.runTask({
        task: gcloud,
        args: "run deploy " + serviceName + " --image " + image + " --region us-east4 --platform managed --port 3000 --allow-unauthenticated"
    })
});