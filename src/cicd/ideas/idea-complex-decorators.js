import { tekton } from "https://storage.googleapis.com/tekton-releases/js-sdk/latest/tekton-sdk.ts"
import { cloudrun } from "https://gcloudsdk.com........."

tekton.init({
    githubCredentials: tekton.getSecret("github-credentials"),
    containerRegistryCredentials: tekton.getSecret("container-registry-credentials"),
    gcpCredentials: tekton.getSecret("gcp-credentials")
});

const rcapprovers = [
    'joe@ourcompany.com',
    'jen@ourcompany.com'
];

// set a github new PR trigger
@tekton.triggers.githubprtrigger("https://github.com/posinaga-demo/elementaltoy")
function prtrigger(ctx, pr) {
    if(pr.targetbranch != 'master') {
        console.log('this is only for the master branch');
        return tekton.FAILED;
    }
    ctx.tasks.rcpipeline(ctx, ctx.githubRequest.gitRepo, ctx.githubRequest.commit_sha);
}

// pipeline for release candidates
@tekton.task
function rcpipeline(ctx, gitRepo, commit_sha) {
    const image_prefix = "gcr.io/elementaltest/";
    const frontend_name_prefix = "elementaltoy-frontend-";
    const loadtest_name_prefix = "elementaltoy-loadtest-"
    const frontend_image = image_prefix + frontend_name_prefix + commit_sha;
    const loadtest_image = image_prefix + loadtest_name_prefix + commit_sha;
    const frontend_ephemeral_servicename = frontend_name_prefix + "ephemeral-" + ctx.commit_sha;
    const frontend_prod_servicename = frontend_name_prefix + "prod";

    @tekton.runtask("build and push frontend")
    var buildfe = ctx.catalog.tasks.kaniko(gitRepo, "./src/frontend", frontend_image);

    @tekton.runtask("build and push load test")
    var buildlt = ctx.catalog.tasks.kaniko(gitRepo, "./src/loadtest", loadtest_image);

    @tekton.taskruns.buildfe.thenruntask("deploy ephemeral frontend")
    function eph_deployfe() {
        ctx.tasks.deploytocloudrun(frontend_image, frontend_ephemeral_servicename);
    }

    @tekton.alltaskruns([ctx.taskruns.buildfe, ctx.taskruns.eph_deployfe]).thenruntask("run load tests")
    function runloadtest() {
        ctx.catalog.tasks.container(loadtest_image,
            "--host " + ctx.globals[frontend_ephemeral_servicename + "-URL"] + " --no-web --clients 10000 --hatch-rate 1000 --run-time 5m)");
    }

    @tekton.taskruns.runloadtest.thenlistenevent("wait for manual RC approval", "1d")
    function approverc() {
        ctx.eventlisteners.approverc.startlistening();
    }

    @tekton.events.approverc.thenruntask("deploying canary to 5% traffic")
    function canarydeploy() {
        ctx.tasks.deploytocloudrun(frontend_image, frontend_prod_servicename, 0.05);
    }

    // QUESTION - would the inline event definition work?
    @tekton.taskruns.canarydeploy.thenlistenevent("wait for ramp approval", "1d")
    function approveramp() {
        ctx.events.inline(tekton.events.githubprcommentevent, (ctx, pr, comment) => {
            if(comment.text == "/ramp") {
                if(rcapprovers.some((rcapprover) => {rcapprover == comment.user})) {
                    console.log("an approver approved the ramp to 100%")
                    return tekton.PASS;
                } else {
                    console.log(comment.user + " not authorized to approve RCs");
                    return tekton.FAIL;
                }
            } else {
                // ignore other comments
                return tekton.IGNORE;
            }
        }).startlistening();        
    }

    @tekton.events.approveramp.thenruntask("ramp to 100% in prod")
    function fulldeploy() {
        ctx.tasks.deploytocloudrun(frontend_image, frontend_prod_servicename, 1);
    }
}

@tekton.task
function deploytocloudrun(ctx, image, serviceName, traffic=1) {
    // NOTE - this doesn't exist in gcloud SDK yet
    // TODO - more would have to be setup (eg project, namespace, etc)
    var service = await cloudrun.deploy(serviceName, image, {
        region: "us-east4",
        platform: "managed",
        port: 3000,
        allowunauthenticated: true,
        traffic: traffic
    });
    if(!service) {
        return tekton.FAIL;
    }
    ctx.globals[serviceName + "-URL"] = service.url;
}

// set a github PR comment event to approve RC
@tekton.eventlisteners.githubprcommentevent
function approverc(ctx, pr, comment) {
    if(comment.text == "/approved") {
        if(rcapprovers.some((rcapprover) => {rcapprover == comment.user})) {
            console.log("an approver approved the RC via github PR comment")
            return tekton.PASS;    
        } else {
            console.log(comment.user + " not authorized to approve RCs");
            return tekton.FAIL;
        }
    } else {
        // ignore other comments
        return tekton.IGNORE;
    }
}